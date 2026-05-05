const express = require('express');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const bodyParser = require('body-parser');
const { Pool } = require('pg');

const app = express();

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Session with Postgres store for Vercel
const pgSession = require('connect-pg-simple')(session);
const pool = new Pool({
    connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.use(session({
    store: new pgSession({ pool, tableName: 'session' }),
    secret: process.env.SESSION_SECRET || 'sillora_secret_key_2024',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// Initialize database
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                price NUMERIC NOT NULL,
                original_price NUMERIC,
                image TEXT,
                in_stock INTEGER DEFAULT 1,
                stock_count INTEGER DEFAULT 5,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                customer_name TEXT NOT NULL,
                phone TEXT NOT NULL,
                address TEXT NOT NULL,
                product_id INTEGER,
                quantity INTEGER DEFAULT 1,
                status TEXT DEFAULT 'pending',
                admin_seen INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS admins (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS session (
                sid VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
                sess JSON NOT NULL,
                expire TIMESTAMP(6) NOT NULL
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS visitors (
                id SERIAL PRIMARY KEY,
                visitor_id VARCHAR(64) UNIQUE NOT NULL,
                ip_hash VARCHAR(64),
                last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Insert default product
        const prod = await pool.query('SELECT * FROM products WHERE id = 1');
        if (prod.rows.length === 0) {
            await pool.query(
                `INSERT INTO products (name, description, price, original_price, image, stock_count)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                ['SILLORA Perfume', 'عطر فاخر بمزيج من البن والفانيليا والزهور البيضاء. ثبات عالٍ وفوحان يدوم طوال اليوم.', 130, 150, '/images/perfume1.png', 5]
            );
        }

        // Insert default admin
        const adm = await pool.query("SELECT * FROM admins WHERE username = 'admin'");
        if (adm.rows.length === 0) {
            const hashedPassword = bcrypt.hashSync('3/5/2026', 10);
            await pool.query("INSERT INTO admins (username, password) VALUES ($1, $2)", ['admin', hashedPassword]);
        }

        console.log('DB initialized successfully');
    } catch (err) {
        console.error('DB Init Error:', err.message);
    }
}

initDB();

// Auth middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.admin) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}

// ========== PUBLIC ROUTES ==========
app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/products/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/orders', async (req, res) => {
    const { customer_name, phone, address, product_id, quantity } = req.body;
    if (!customer_name || !phone || !address) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    try {
        const result = await pool.query(
            `INSERT INTO orders (customer_name, phone, address, product_id, quantity)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [customer_name, phone, address, product_id || 1, quantity || 1]
        );
        await pool.query('UPDATE products SET stock_count = stock_count - $1 WHERE id = $2', [quantity || 1, product_id || 1]);
        res.json({ id: result.rows[0].id, message: 'Order placed successfully!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========== ADMIN ROUTES ==========
app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
        const user = result.rows[0];
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });
        if (bcrypt.compareSync(password, user.password)) {
            req.session.admin = { id: user.id, username: user.username };
            req.session.save(() => {
                res.json({ message: 'Login successful', admin: req.session.admin });
            });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ message: 'Logged out' });
    });
});

app.get('/api/admin/me', requireAuth, (req, res) => {
    res.json({ admin: req.session.admin });
});

app.get('/api/admin/orders', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT o.*, p.name as product_name, p.price as product_price
             FROM orders o LEFT JOIN products p ON o.product_id = p.id
             ORDER BY o.created_at DESC`
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/orders/:id/seen', requireAuth, async (req, res) => {
    try {
        await pool.query('UPDATE orders SET admin_seen = 1 WHERE id = $1', [req.params.id]);
        res.json({ message: 'Order marked as seen' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/orders/:id/status', requireAuth, async (req, res) => {
    const { status } = req.body;
    try {
        await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, req.params.id]);
        res.json({ message: 'Status updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/products/:id/stock', requireAuth, async (req, res) => {
    const { in_stock, stock_count } = req.body;
    try {
        await pool.query('UPDATE products SET in_stock = $1, stock_count = $2 WHERE id = $3', [in_stock, stock_count, req.params.id]);
        res.json({ message: 'Stock updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/stats', requireAuth, async (req, res) => {
    try {
        const orders = await pool.query('SELECT COUNT(*) as total_orders FROM orders');
        const pending = await pool.query("SELECT COUNT(*) as pending_orders FROM orders WHERE status = 'pending'");
        const unseen = await pool.query('SELECT COUNT(*) as unseen_orders FROM orders WHERE admin_seen = 0');
        const revenue = await pool.query(
            `SELECT SUM(p.price * o.quantity) as revenue
             FROM orders o JOIN products p ON o.product_id = p.id
             WHERE o.status = 'completed'`
        );
        res.json({
            total_orders: parseInt(orders.rows[0].total_orders) || 0,
            pending_orders: parseInt(pending.rows[0].pending_orders) || 0,
            unseen_orders: parseInt(unseen.rows[0].unseen_orders) || 0,
            revenue: revenue.rows[0].revenue ? parseFloat(revenue.rows[0].revenue) : 0
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========== VISITOR TRACKING ==========
app.post('/api/visitors/track', async (req, res) => {
    const { visitor_id } = req.body;
    if (!visitor_id) return res.status(400).json({ error: 'visitor_id required' });

    try {
        const now = new Date();
        const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);

        // Upsert: update last_active if exists, else insert
        const existing = await pool.query('SELECT * FROM visitors WHERE visitor_id = $1', [visitor_id]);
        if (existing.rows.length > 0) {
            await pool.query('UPDATE visitors SET last_active = CURRENT_TIMESTAMP WHERE visitor_id = $1', [visitor_id]);
        } else {
            await pool.query(
                'INSERT INTO visitors (visitor_id, ip_hash, last_active) VALUES ($1, $2, CURRENT_TIMESTAMP)',
                [visitor_id, req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown']
            );
        }

        // Clean old records (older than 1 day)
        await pool.query("DELETE FROM visitors WHERE last_active < CURRENT_TIMESTAMP - INTERVAL '1 day'");

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/visitors', requireAuth, async (req, res) => {
    try {
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);

        const onlineResult = await pool.query(
            "SELECT COUNT(DISTINCT visitor_id) as online FROM visitors WHERE last_active > CURRENT_TIMESTAMP - INTERVAL '5 minutes'"
        );
        const todayResult = await pool.query(
            "SELECT COUNT(DISTINCT visitor_id) as today FROM visitors WHERE first_seen::date = CURRENT_DATE"
        );
        const totalResult = await pool.query(
            'SELECT COUNT(DISTINCT visitor_id) as total FROM visitors'
        );

        res.json({
            online: parseInt(onlineResult.rows[0].online) || 0,
            today: parseInt(todayResult.rows[0].today) || 0,
            total: parseInt(totalResult.rows[0].total) || 0
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = (req, res) => app(req, res);
