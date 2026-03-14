const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');

if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, 'uploads/') },
    filename: function (req, file, cb) { cb(null, Date.now() + path.extname(file.originalname)) }
});
const upload = multer({ storage: storage });

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const JWT_SECRET = 'nomura_forex_secreto_2026';

const dbConfig = {
    host: 'hv-par6-004.clvrcld.net',
    port: 11534,
    user: 'udpmcmp4kdbun85y',
    password: 'GjcaNGfXmndAB3FbskPN',
    database: 'b7epi1wsbbgdnvz33xix'
};

const pool = mysql.createPool(dbConfig);

const verificarToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(403).json({ error: 'Token requerido' });
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ error: 'Token inválido' });
        req.user = decoded;
        next();
    });
};

function connectBinance() {
    const binanceWs = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@ticker/ethusdt@ticker/solusdt@ticker/xrpusdt@ticker/adausdt@ticker/dogeusdt@ticker/dotusdt@ticker/maticusdt@ticker/ltcusdt@ticker/linkusdt@ticker');
    binanceWs.on('message', (data) => {
        const td = JSON.parse(data);
        preciosActuales[td.s] = { price: parseFloat(td.c), change: parseFloat(td.P) };
        io.emit('precio_actualizado', { symbol: td.s, precio: parseFloat(td.c), cambio: parseFloat(td.P) });
    });
    binanceWs.on('close', () => setTimeout(connectBinance, 5000)); 
    binanceWs.on('error', (err) => console.log('Fallo menor de red Binance...')); 
}
let preciosActuales = {};
connectBinance();

let bullionPrice = 5200.00, b_targetPrice = null, b_step = 0, b_endTime = 0;
async function cargarPrecioBullion() {
    try {
        const [rows] = await pool.execute('SELECT precio FROM bullion_history ORDER BY id DESC LIMIT 1');
        if (rows.length > 0) bullionPrice = parseFloat(rows[0].precio);
        preciosActuales['BULLIONUSDT'] = { price: bullionPrice, change: 0 };
    } catch (e) {}
}
cargarPrecioBullion();

// EMISOR EN VIVO (Mueve el precio en pantalla rápido)
setInterval(async () => {
    let now = Date.now();
    if (b_targetPrice && now < b_endTime) bullionPrice += b_step;
    else {
        b_targetPrice = null; 
        let varP = (Math.random() - 0.5) * 6;
        bullionPrice += varP;
        if (bullionPrice > 5400) bullionPrice -= Math.abs(varP) * 2;
        if (bullionPrice < 5000) bullionPrice += Math.abs(varP) * 2;
    }
    preciosActuales['BULLIONUSDT'] = { price: bullionPrice, change: 0 };
    io.emit('precio_actualizado', { symbol: 'BULLIONUSDT', precio: bullionPrice, cambio: 0 });
}, 2000);

// 🔥 GUARDADO INTERNO AUTOMÁTICO EXACTAMENTE CADA 15 MINUTOS (Independiente de los usuarios)
setInterval(async () => {
    let ahora = new Date();
    // Verifica si el reloj de la computadora del servidor está en los minutos 0, 15, 30 o 45 y en el segundo 0
    if (ahora.getMinutes() % 15 === 0 && ahora.getSeconds() === 0) {
        try {
            await pool.execute('INSERT INTO bullion_history (precio) VALUES (?)', [bullionPrice]);
            console.log(`Bullion guardado automáticamente: ${bullionPrice}`);
        } catch (e) {
            console.error("Error guardando historial:", e);
        }
    }
}, 1000); // El reloj interno hace "tic tac" cada segundo buscando el momento exacto

setInterval(async () => {
    try {
        const [abiertas] = await pool.execute('SELECT * FROM trades WHERE estado = "abierta"');
        for (let trade of abiertas) {
            if (!trade.tp && !trade.sl) continue;
            const liveData = preciosActuales[trade.criptomoneda];
            if (!liveData) continue;
            const livePrice = liveData.price;
            let closeTrade = false, motivo = '';

            if (trade.tipo_operacion === 'compra_long') {
                if (trade.tp && livePrice >= trade.tp) { closeTrade = true; motivo = 'Take Profit'; }
                else if (trade.sl && livePrice <= trade.sl) { closeTrade = true; motivo = 'Stop Loss'; }
            } else if (trade.tipo_operacion === 'venta_short') {
                if (trade.tp && livePrice <= trade.tp) { closeTrade = true; motivo = 'Take Profit'; }
                else if (trade.sl && livePrice >= trade.sl) { closeTrade = true; motivo = 'Stop Loss'; }
            }

            if (closeTrade) {
                const varPct = (livePrice - trade.precio_entrada) / trade.precio_entrada;
                let pnl = trade.tipo_operacion === 'compra_long' ? (varPct * trade.monto_invertido) : (-varPct * trade.monto_invertido);
                await pool.execute('UPDATE trades SET estado = "cerrada", precio_cierre = ?, ganancia_perdida = ? WHERE id = ?', [livePrice, pnl, trade.id]);
                await pool.execute('UPDATE users SET saldo_demo = saldo_demo + ? WHERE id = ?', [parseFloat(trade.monto_invertido) + pnl, trade.user_id]);
                io.emit('auto_close', { user_id: trade.user_id, trade_id: trade.id, motivo: motivo, pnl: pnl.toFixed(2) });
            }
        }
    } catch (e) {}
}, 2000); 

io.on('connection', (socket) => {
    socket.on('mensaje_usuario', async (data) => {
        try {
            const decoded = jwt.verify(data.token, JWT_SECRET);
            await pool.execute('INSERT INTO support_messages (user_id, is_admin, mensaje) VALUES (?, false, ?)', [decoded.id, data.mensaje]);
            io.emit('chat_actualizado', { user_id: decoded.id, nombre: decoded.nombre, mensaje: data.mensaje, is_admin: false });
        } catch (e) {}
    });

    socket.on('mensaje_admin', async (data) => {
        try {
            jwt.verify(data.token, JWT_SECRET); 
            await pool.execute('INSERT INTO support_messages (user_id, is_admin, mensaje) VALUES (?, true, ?)', [data.user_id, data.mensaje]);
            io.emit('chat_actualizado', { user_id: data.user_id, nombre: 'Soporte Nomura', mensaje: data.mensaje, is_admin: true });
        } catch (e) {}
    });
});

app.get('/api/chat/mi-historial', verificarToken, async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT is_admin, mensaje FROM support_messages WHERE user_id = ? ORDER BY fecha ASC', [req.user.id]);
        res.json(rows);
    } catch(e) { res.status(500).json({error: 'Error'}); }
});

app.get('/api/admin/chat/usuarios', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT DISTINCT u.id, u.nombre FROM support_messages s JOIN users u ON s.user_id = u.id');
        res.json(rows);
    } catch(e) { res.status(500).json({error: 'Error'}); }
});

app.get('/api/admin/chat/historial/:id', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT is_admin, mensaje FROM support_messages WHERE user_id = ? ORDER BY fecha ASC', [req.params.id]);
        res.json(rows);
    } catch(e) { res.status(500).json({error: 'Error'}); }
});

app.get('/api/historial-grafico', async (req, res) => {
    const { symbol, interval } = req.query;
    
    if (symbol === 'BULLIONUSDT') {
        try {
            // Traemos los puntos de 15 minutos guardados
            const [rows] = await pool.execute('SELECT UNIX_TIMESTAMP(fecha) as time, precio as value FROM bullion_history ORDER BY id DESC LIMIT 1000');
            let result = rows.map(r => ({ time: r.time, value: parseFloat(r.value) })).reverse();
            
            // Le adjuntamos el precio vivo como la última vela en movimiento
            let now15m = Math.floor(Date.now() / 1000 / 900) * 900;
            result.push({ time: now15m, value: bullionPrice });
            
            return res.json(result);
        } catch (e) { return res.status(500).json({ error: 'Error DB' }); }
    }
    
    try {
        let limit = 1000;
        const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
        const data = await response.json();
        res.json(data.map(d => ({ time: d[0] / 1000, value: parseFloat(d[4]) })));
    } catch (error) { res.status(500).json({ error: 'Error Binance' }); }
});

app.post('/api/register', upload.fields([{ name: 'foto_perfil' }, { name: 'documento_identidad' }]), async (req, res) => {
    try {
        const { nombre, apellido, email, password, pais, telefono, codigo_invitacion } = req.body;
        if (!req.files) return res.status(400).json({ error: 'El formulario no envió archivos correctamente.' });

        const foto_perfil = req.files['foto_perfil'] ? '/uploads/' + req.files['foto_perfil'][0].filename : null;
        const doc = req.files['documento_identidad'] ? '/uploads/' + req.files['documento_identidad'][0].filename : null;
        
        if (!nombre || !apellido || !email || !password || !doc || !pais || !telefono) return res.status(400).json({ error: 'Faltan datos obligatorios' });

        const [exist] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
        const hash = await bcrypt.hash(password, 10);

        if (exist.length > 0) {
            if (exist[0].modo_recuperacion) {
                await pool.execute(
                    'UPDATE users SET nombre=?, apellido=?, password_hash=?, foto_perfil=?, documento_identidad=?, pais=?, telefono=?, modo_recuperacion=FALSE, estado_cuenta="pendiente" WHERE email=?',
                    [nombre, apellido, hash, foto_perfil || exist[0].foto_perfil, doc, pais, telefono, email]
                );
                return res.status(200).json({ mensaje: 'Cuenta recuperada exitosamente. En revisión KYC.' });
            } else {
                return res.status(400).json({ error: 'El correo ya está registrado.' });
            }
        }

        const mi_codigo = Math.random().toString(36).substring(2, 8).toUpperCase();
        let saldo_inicial = 0;

        if (codigo_invitacion && codigo_invitacion.trim() !== '') {
            const [refs] = await pool.execute('SELECT id FROM users WHERE mi_codigo = ?', [codigo_invitacion.trim().toUpperCase()]);
            if (refs.length > 0) {
                saldo_inicial = 10; 
                await pool.execute('UPDATE users SET saldo_demo = saldo_demo + 10 WHERE id = ?', [refs[0].id]); 
            }
        }

        await pool.execute('INSERT INTO users (nombre, apellido, email, password_hash, foto_perfil, documento_identidad, pais, telefono, mi_codigo, saldo_demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 
            [nombre, apellido, email, hash, foto_perfil, doc, pais, telefono, mi_codigo, saldo_inicial]
        );
        res.status(201).json({ mensaje: 'Cuenta creada. En revisión KYC.' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const [users] = await pool.execute('SELECT * FROM users WHERE email = ?', [req.body.email]);
        if (users.length === 0) return res.status(401).json({ error: 'Credenciales inválidas' });
        const user = users[0];
        
        if (user.estado_cuenta === 'pendiente') return res.status(403).json({ error: 'Cuenta en revisión KYC.' });
        if (user.estado_cuenta === 'rechazado') return res.status(403).json({ error: 'KYC rechazado.' });

        const match = await bcrypt.compare(req.body.password, user.password_hash);
        if (!match) return res.status(401).json({ error: 'Credenciales inválidas' });

        let rolAsignado = user.email === 'akirakobayashizh@gmail.com' ? 'admin' : 'user';
        const token = jwt.sign({ id: user.id, nombre: user.nombre, rol: rolAsignado }, JWT_SECRET, { expiresIn: '8h' });
        res.status(200).json({ token, user: { id: user.id, nombre: user.nombre, rol: rolAsignado, foto_perfil: user.foto_perfil } });
    } catch (e) { res.status(500).json({ error: 'Error servidor' }); }
});

app.post('/api/recuperar-password', upload.single('documento_recuperacion'), async (req, res) => {
    try {
        const { email, telefono } = req.body;
        const doc = req.file ? '/uploads/' + req.file.filename : null;
        if (!email || !telefono || !doc) return res.status(400).json({ error: 'Faltan datos' });

        const [exist] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (exist.length === 0) return res.status(400).json({ error: 'El correo no existe en el sistema' });

        await pool.execute('INSERT INTO password_resets (email, telefono, documento_identidad) VALUES (?, ?, ?)', [email, telefono, doc]);
        res.json({ mensaje: 'Solicitud enviada al Administrador. Espere aprobación.' });
    } catch (e) { res.status(500).json({ error: 'Error al solicitar recuperación' }); }
});

app.get('/api/user/perfil', verificarToken, async (req, res) => {
    try {
        const [users] = await pool.execute('SELECT nombre, saldo_demo, mi_codigo FROM users WHERE id = ?', [req.user.id]);
        res.json(users[0]);
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/user/recarga', verificarToken, async (req, res) => {
    try {
        await pool.execute('INSERT INTO transactions (user_id, tipo, monto) VALUES (?, "recarga", ?)', [req.user.id, req.body.monto]);
        res.json({ mensaje: 'Solicitud enviada.' });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/user/retiro', verificarToken, upload.single('documento_retiro'), async (req, res) => {
    try {
        const { monto, billetera } = req.body;
        const doc = req.file ? '/uploads/' + req.file.filename : null;
        if (!monto || monto <= 0 || !billetera || !doc) return res.status(400).json({ error: 'Datos incompletos' });

        const [users] = await pool.execute('SELECT saldo_demo FROM users WHERE id = ?', [req.user.id]);
        if (users[0].saldo_demo < monto) return res.status(400).json({ error: 'Saldo insuficiente' });

        await pool.execute('UPDATE users SET saldo_demo = saldo_demo - ? WHERE id = ?', [monto, req.user.id]); 
        await pool.execute('INSERT INTO transactions (user_id, tipo, monto, billetera_retiro, documento_retiro) VALUES (?, "retiro", ?, ?, ?)', [req.user.id, monto, billetera, doc]);
        res.json({ mensaje: 'Solicitud de retiro en proceso.' });
    } catch (e) { res.status(500).json({ error: 'Error al procesar retiro' }); }
});

app.post('/api/trade/abrir', verificarToken, async (req, res) => {
    try {
        const { criptomoneda, tipo_operacion, monto_invertido, tp, sl } = req.body;
        const precio_entrada = preciosActuales[criptomoneda]?.price;
        if (!precio_entrada) return res.status(400).json({ error: 'Precio no disponible' });

        const [users] = await pool.execute('SELECT saldo_demo FROM users WHERE id = ?', [req.user.id]);
        if (users[0].saldo_demo < monto_invertido) return res.status(400).json({ error: 'Saldo insuficiente' });

        await pool.execute('UPDATE users SET saldo_demo = saldo_demo - ? WHERE id = ?', [monto_invertido, req.user.id]);
        const [result] = await pool.execute(
            'INSERT INTO trades (user_id, criptomoneda, tipo_operacion, precio_entrada, monto_invertido, tp, sl) VALUES (?, ?, ?, ?, ?, ?, ?)', 
            [req.user.id, criptomoneda, tipo_operacion, precio_entrada, monto_invertido, tp || null, sl || null]
        );
        res.json({ mensaje: 'Orden abierta', trade_id: result.insertId, precio_entrada });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/trade/cerrar', verificarToken, async (req, res) => {
    try {
        const [trades] = await pool.execute('SELECT * FROM trades WHERE id = ? AND user_id = ? AND estado = "abierta"', [req.body.trade_id, req.user.id]);
        if (trades.length === 0) return res.status(404).json({ error: 'No encontrada' });
        
        const trade = trades[0], precio_cierre = preciosActuales[trade.criptomoneda]?.price;
        const varPct = (precio_cierre - trade.precio_entrada) / trade.precio_entrada;
        let pnl = trade.tipo_operacion === 'compra_long' ? (varPct * trade.monto_invertido) : (-varPct * trade.monto_invertido);
        
        await pool.execute('UPDATE trades SET estado = "cerrada", precio_cierre = ?, ganancia_perdida = ? WHERE id = ?', [precio_cierre, pnl, req.body.trade_id]);
        await pool.execute('UPDATE users SET saldo_demo = saldo_demo + ? WHERE id = ?', [parseFloat(trade.monto_invertido) + pnl, req.user.id]);
        res.json({ mensaje: 'Posición cerrada exitosamente', pnl: pnl.toFixed(2) });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/user/historial', verificarToken, async (req, res) => {
    try {
        const [historial] = await pool.execute('SELECT * FROM trades WHERE user_id = ? AND estado = "cerrada" ORDER BY fecha_apertura DESC LIMIT 20', [req.user.id]);
        const [abiertas] = await pool.execute('SELECT * FROM trades WHERE user_id = ? AND estado = "abierta"', [req.user.id]);
        res.json({ historial, abiertas });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/admin/usuarios-pendientes', async (req, res) => {
    try {
        const [users] = await pool.execute('SELECT * FROM users WHERE estado_cuenta = "pendiente"');
        res.json(users);
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});
app.post('/api/admin/usuarios/:id/verificar', async (req, res) => {
    try {
        await pool.execute('UPDATE users SET estado_cuenta = ? WHERE id = ?', [req.body.accion, req.params.id]);
        res.json({ mensaje: `Procesado` });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});
app.get('/api/admin/transacciones', async (req, res) => {
    try {
        const [txs] = await pool.execute('SELECT t.*, u.nombre, u.email FROM transactions t JOIN users u ON t.user_id = u.id WHERE t.estado = "pendiente"');
        res.json(txs);
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});
app.post('/api/admin/transacciones/:id', async (req, res) => {
    try {
        const [txs] = await pool.execute('SELECT * FROM transactions WHERE id = ?', [req.params.id]);
        if (req.body.accion === 'aprobar') {
            await pool.execute('UPDATE transactions SET estado = "aprobada" WHERE id = ?', [txs[0].id]);
            if (txs[0].tipo === 'recarga') await pool.execute('UPDATE users SET saldo_demo = saldo_demo + ? WHERE id = ?', [txs[0].monto, txs[0].user_id]);
        } else {
            await pool.execute('UPDATE transactions SET estado = "rechazada" WHERE id = ?', [txs[0].id]);
            if (txs[0].tipo === 'retiro') await pool.execute('UPDATE users SET saldo_demo = saldo_demo + ? WHERE id = ?', [txs[0].monto, txs[0].user_id]); 
        }
        res.json({ mensaje: `Transacción procesada` });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/admin/recuperaciones', async (req, res) => {
    try {
        const [reqs] = await pool.execute('SELECT * FROM password_resets WHERE estado = "pendiente"');
        res.json(reqs);
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});
app.post('/api/admin/recuperaciones/:id', async (req, res) => {
    try {
        const [reqs] = await pool.execute('SELECT * FROM password_resets WHERE id = ?', [req.params.id]);
        if (req.body.accion === 'aprobar') {
            await pool.execute('UPDATE password_resets SET estado = "aprobada" WHERE id = ?', [req.params.id]);
            await pool.execute('UPDATE users SET modo_recuperacion = TRUE WHERE email = ?', [reqs[0].email]);
        } else {
            await pool.execute('UPDATE password_resets SET estado = "rechazada" WHERE id = ?', [req.params.id]);
        }
        res.json({ mensaje: `Procesado` });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/bullion-manipular', async (req, res) => {
    const { porcentaje, minutos } = req.body;
    if (porcentaje === 0) { b_targetPrice = null; return res.json({ mensaje: 'Automático' }); }
    const aumento = bullionPrice * (porcentaje / 100);
    b_targetPrice = bullionPrice + aumento;
    b_step = aumento / ((minutos * 60) / 2);
    b_endTime = Date.now() + (minutos * 60 * 1000);
    res.json({ mensaje: `Manipulando: Objetivo ${b_targetPrice.toFixed(2)}` });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Nomura Forex en puerto ${PORT}, Conectado a la Nube!`));