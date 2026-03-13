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

// =========================================================
// 1. SOLUCIÓN ANTICRASH PARA LAS FOTOS
// Render borra las carpetas vacías. Esto la crea automáticamente.
// =========================================================
if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/')
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + path.extname(file.originalname))
    }
});

const upload = multer({ storage: storage });

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const JWT_SECRET = 'nomura_forex_secreto_2026';

// =========================================================
// 2. CONEXIÓN PRO A CLEVER CLOUD (RUTA DIRECTA)
// =========================================================
const dbConfig = {
    host: 'hv-par6-004.clvrcld.net',
    port: 11534,
    user: 'udpmcmp4kdbun85y',
    password: 'GjcaNGfXmndAB3FbskPN',
    database: 'b7epilwsbbgdnvz33xix'
};

// ¡AQUÍ ESTÁ LA LÍNEA MÁGICA QUE FALTABA PARA ENCENDER LA BASE DE DATOS!
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
// --- WEBSOCKETS BINANCE & BULLION ---
function connectBinance() {
    const binanceWs = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@ticker/ethusdt@ticker/solusdt@ticker/xrpusdt@ticker/adausdt@ticker/dogeusdt@ticker/dotusdt@ticker/maticusdt@ticker/ltcusdt@ticker/linkusdt@ticker');
    binanceWs.on('message', (data) => {
        const td = JSON.parse(data);
        preciosActuales[td.s] = { price: parseFloat(td.c), change: parseFloat(td.P) };
        io.emit('precio_actualizado', { symbol: td.s, precio: parseFloat(td.c), cambio: parseFloat(td.P) });
    });
    binanceWs.on('close', () => setTimeout(connectBinance, 5000)); 
    // SALVAVIDAS PARA RENDER: Evita que el servidor se apague si Binance falla la conexión un segundo
    binanceWs.on('error', (err) => console.log('Fallo menor de red con Binance, ignorando y reintentando...')); 
}
let preciosActuales = {};
connectBinance();

let bullionPrice = 5200.00, b_targetPrice = null, b_step = 0, b_endTime = 0, lastSaveTime = 0;
async function cargarPrecioBullion() {
    try {
        const conn = await mysql.createConnection(dbConfig);
        const [rows] = await conn.execute('SELECT precio FROM bullion_history ORDER BY id DESC LIMIT 1');
        if (rows.length > 0) bullionPrice = parseFloat(rows[0].precio);
        preciosActuales['BULLIONUSDT'] = { price: bullionPrice, change: 0 };
        await conn.end();
    } catch (e) { console.error("Aviso: Aún no hay historial de Bullion."); }
}
cargarPrecioBullion();

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

    if (now - lastSaveTime > 60000) {
        try {
            const conn = await mysql.createConnection(dbConfig);
            await conn.execute('INSERT INTO bullion_history (precio) VALUES (?)', [bullionPrice]);
            await conn.end(); lastSaveTime = now;
        } catch (e) {}
    }
}, 2000);

// --- VIGILANTE DE TP Y SL ---
setInterval(async () => {
    try {
        const conn = await mysql.createConnection(dbConfig);
        const [abiertas] = await conn.execute('SELECT * FROM trades WHERE estado = "abierta"');
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
                await conn.execute('UPDATE trades SET estado = "cerrada", precio_cierre = ?, ganancia_perdida = ? WHERE id = ?', [livePrice, pnl, trade.id]);
                await conn.execute('UPDATE users SET saldo_demo = saldo_demo + ? WHERE id = ?', [parseFloat(trade.monto_invertido) + pnl, trade.user_id]);
                io.emit('auto_close', { user_id: trade.user_id, trade_id: trade.id, motivo: motivo, pnl: pnl.toFixed(2) });
            }
        }
        await conn.end();
    } catch (e) {}
}, 2000); 

// --- CHAT PRIVADO WEBSOCKET ---
io.on('connection', (socket) => {
    socket.on('mensaje_usuario', async (data) => {
        try {
            const decoded = jwt.verify(data.token, JWT_SECRET);
            const conn = await mysql.createConnection(dbConfig);
            await conn.execute('INSERT INTO support_messages (user_id, is_admin, mensaje) VALUES (?, false, ?)', [decoded.id, data.mensaje]);
            await conn.end();
            io.emit('chat_actualizado', { user_id: decoded.id, nombre: decoded.nombre, mensaje: data.mensaje, is_admin: false });
        } catch (e) {}
    });

    socket.on('mensaje_admin', async (data) => {
        try {
            jwt.verify(data.token, JWT_SECRET); 
            const conn = await mysql.createConnection(dbConfig);
            await conn.execute('INSERT INTO support_messages (user_id, is_admin, mensaje) VALUES (?, true, ?)', [data.user_id, data.mensaje]);
            await conn.end();
            io.emit('chat_actualizado', { user_id: data.user_id, nombre: 'Soporte Nomura', mensaje: data.mensaje, is_admin: true });
        } catch (e) {}
    });
});

app.get('/api/chat/mi-historial', verificarToken, async (req, res) => {
    try {
        const conn = await mysql.createConnection(dbConfig);
        const [rows] = await conn.execute('SELECT is_admin, mensaje FROM support_messages WHERE user_id = ? ORDER BY fecha ASC', [req.user.id]);
        await conn.end(); res.json(rows);
    } catch(e) { res.status(500).json({error: 'Error'}); }
});

app.get('/api/admin/chat/usuarios', async (req, res) => {
    try {
        const conn = await mysql.createConnection(dbConfig);
        const [rows] = await conn.execute('SELECT DISTINCT u.id, u.nombre FROM support_messages s JOIN users u ON s.user_id = u.id');
        await conn.end(); res.json(rows);
    } catch(e) { res.status(500).json({error: 'Error'}); }
});

app.get('/api/admin/chat/historial/:id', async (req, res) => {
    try {
        const conn = await mysql.createConnection(dbConfig);
        const [rows] = await conn.execute('SELECT is_admin, mensaje FROM support_messages WHERE user_id = ? ORDER BY fecha ASC', [req.params.id]);
        await conn.end(); res.json(rows);
    } catch(e) { res.status(500).json({error: 'Error'}); }
});

app.get('/api/historial-grafico', async (req, res) => {
    const { symbol, interval } = req.query;
    if (symbol === 'BULLIONUSDT') {
        try {
            const conn = await mysql.createConnection(dbConfig);
            const [rows] = await conn.execute('SELECT UNIX_TIMESTAMP(fecha) as time, precio as value FROM bullion_history ORDER BY fecha ASC LIMIT 1000');
            await conn.end(); return res.json(rows);
        } catch (e) { return res.status(500).json({ error: 'Error DB' }); }
    }
    try {
        let limit = 1000;
        const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
        const data = await response.json();
        res.json(data.map(d => ({ time: d[0] / 1000, value: parseFloat(d[4]) })));
    } catch (error) { res.status(500).json({ error: 'Error Binance' }); }
});

// --- SISTEMA DE REGISTRO Y RECUPERACIÓN ---
app.post('/api/register', upload.fields([{ name: 'foto_perfil' }, { name: 'documento_identidad' }]), async (req, res) => {
    try {
        const { nombre, apellido, email, password, pais, telefono, codigo_invitacion } = req.body;
        
        // Protección anti-crash si Multer falla o no se envían archivos
        if (!req.files) return res.status(400).json({ error: 'El formulario no envió archivos correctamente.' });

        const foto_perfil = req.files['foto_perfil'] ? '/uploads/' + req.files['foto_perfil'][0].filename : null;
        const doc = req.files['documento_identidad'] ? '/uploads/' + req.files['documento_identidad'][0].filename : null;
        
        if (!nombre || !apellido || !email || !password || !doc || !pais || !telefono) {
            return res.status(400).json({ error: 'Faltan datos obligatorios' });
        }

        // USAMOS EL POOL: Inteligente, no se satura y se cierra solo.
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

    } catch (e) { 
        // ¡QUITAMOS LA MORDAZA! Si algo falla, Render gritará y el panel de Red te dirá el porqué exacto.
        console.error("🔥 ERROR GRAVE EN REGISTRO:", e);
        res.status(500).json({ error: e.message }); 
    }
});