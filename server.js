const express = require('express');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'sillora_secret_key_2024',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

// Database setup - use postgres if POSTGRES_URL is available, otherwise sqlite
let usePostgres = !!(process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL);
let sql, db;

if (usePostgres) {
    const postgres = require('postgres');
    sql = postgres(process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL);
    console.log('Using Postgres database');
} else {
    const sqlite3 = require('sqlite3').verbose();
    const dbPath = 'database.sqlite';
    db = new sqlite3.Database(dbPath, (err) => {
        if (err) console.error('Error opening database:', err.message);
        else console.log('Connected to SQLite database');
    });
    console.log('Using SQLite database');
}

// Initialize database
async function initDB() {
    if (usePostgres) {
        await sql`
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                price REAL NOT NULL,
                original_price REAL,
                image TEXT,
                in_stock INTEGER DEFAULT 1,
                stock_count INTEGER DEFAULT 5,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `;
        await sql`
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
        `;
        await sql`
            CREATE TABLE IF NOT EXISTS admins (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL
            )
        `;
        const products = await sql`SELECT * FROM products WHERE id = 1`;
        if (products.length === 0) {
            await sql`
                INSERT INTO products (name, description, price, original_price, image, stock_count)
                VALUES ('SILLORA Perfume', 'عطر فاخر بمزيج من البن والفانيليا والزهور البيضاء. ثبات عالٍ وفوحان يدوم طوال اليوم.', 130, 150, '/images/perfume1.png', 5)
            `;
        }
        const admins = await sql`SELECT * FROM admins WHERE username = 'admin'`;
        if (admins.length === 0) {
            const hashedPassword = bcrypt.hashSync('3/5/2026', 10);
            await sql`INSERT INTO admins (username, password) VALUES ('admin', ${hashedPassword})`;
        }
    } else {
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT,
                price REAL NOT NULL, original_price REAL, image TEXT, in_stock INTEGER DEFAULT 1,
                stock_count INTEGER DEFAULT 5, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
            db.run(`CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT, customer_name TEXT NOT NULL, phone TEXT NOT NULL,
                address TEXT NOT NULL, product_id INTEGER, quantity INTEGER DEFAULT 1, status TEXT DEFAULT 'pending',
                admin_seen INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
            db.run(`CREATE TABLE IF NOT EXISTS admins (
                id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL)`);
            db.get("SELECT * FROM products WHERE id = 1", (err, row) => {
                if (!row) {
                    db.run(`INSERT INTO products (name, description, price, original_price, image, stock_count)
                        VALUES (?, ?, ?, ?, ?, ?)`,
                        ['SILLORA Perfume', 'عطر فاخر بمزيج من البن والفانيليا والزهور البيضاء. ثبات عالٍ وفوحان يدوم طوال اليوم.', 130, 150, '/images/perfume1.png', 5]);
                }
            });
            db.get("SELECT * FROM admins WHERE username = 'admin'", (err, row) => {
                if (!row) {
                    const hashedPassword = bcrypt.hashSync('3/5/2026', 10);
                    db.run("INSERT INTO admins (username, password) VALUES (?, ?)", ['admin', hashedPassword]);
                }
            });
        });
    }
}

initDB();

// Auth middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.admin) next();
    else res.status(401).json({ error: 'Unauthorized' });
}

// ========== PUBLIC ROUTES ==========
app.get('/api/products', async (req, res) => {
    try {
        const rows = usePostgres
            ? await sql`SELECT * FROM products`
            : await new Promise((resolve, reject) => db.all("SELECT * FROM products", [], (err, rows) => err ? reject(err) : resolve(rows)));
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/products/:id', async (req, res) => {
    try {
        const rows = usePostgres
            ? await sql`SELECT * FROM products WHERE id = ${req.params.id}`
            : await new Promise((resolve, reject) => db.get("SELECT * FROM products WHERE id = ?", [req.params.id], (err, row) => err ? reject(err) : resolve([row])));
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/orders', async (req, res) => {
    const { customer_name, phone, address, product_id, quantity } = req.body;
    if (!customer_name || !phone || !address) return res.status(400).json({ error: 'All fields are required' });
    try {
        if (usePostgres) {
            const result = await sql`
                INSERT INTO orders (customer_name, phone, address, product_id, quantity)
                VALUES (${customer_name}, ${phone}, ${address}, ${product_id || 1}, ${quantity || 1})
                RETURNING id
            `;
            await sql`UPDATE products SET stock_count = stock_count - ${quantity || 1} WHERE id = ${product_id || 1}`;
            res.json({ id: result[0].id, message: 'Order placed successfully!' });
        } else {
            db.run(`INSERT INTO orders (customer_name, phone, address, product_id, quantity) VALUES (?, ?, ?, ?, ?)`,
                [customer_name, phone, address, product_id || 1, quantity || 1],
                function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    db.run("UPDATE products SET stock_count = stock_count - ? WHERE id = ?", [quantity || 1, product_id || 1]);
                    res.json({ id: this.lastID, message: 'Order placed successfully!' });
                });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== ADMIN ROUTES ==========
app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const userRows = usePostgres
            ? await sql`SELECT * FROM admins WHERE username = ${username}`
            : await new Promise((resolve, reject) => db.get("SELECT * FROM admins WHERE username = ?", [username], (err, row) => err ? reject(err) : resolve(row ? [row] : [])));
        const user = userRows[0];
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });
        if (bcrypt.compareSync(password, user.password)) {
            req.session.admin = { id: user.id, username: user.username };
            res.json({ message: 'Login successful', admin: req.session.admin });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/logout', (req, res) => { req.session.destroy(); res.json({ message: 'Logged out' }); });

app.get('/api/admin/me', requireAuth, (req, res) => { res.json({ admin: req.session.admin }); });

app.get('/api/admin/orders', requireAuth, async (req, res) => {
    try {
        const rows = usePostgres
            ? await sql`SELECT o.*, p.name as product_name, p.price as product_price FROM orders o LEFT JOIN products p ON o.product_id = p.id ORDER BY o.created_at DESC`
            : await new Promise((resolve, reject) => db.all(`SELECT o.*, p.name as product_name, p.price as product_price FROM orders o LEFT JOIN products p ON o.product_id = p.id ORDER BY o.created_at DESC`, [], (err, rows) => err ? reject(err) : resolve(rows)));
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/orders/:id/seen', requireAuth, async (req, res) => {
    try {
        usePostgres
            ? await sql`UPDATE orders SET admin_seen = 1 WHERE id = ${req.params.id}`
            : db.run("UPDATE orders SET admin_seen = 1 WHERE id = ?", [req.params.id]);
        res.json({ message: 'Order marked as seen' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/orders/:id/status', requireAuth, async (req, res) => {
    const { status } = req.body;
    try {
        usePostgres
            ? await sql`UPDATE orders SET status = ${status} WHERE id = ${req.params.id}`
            : db.run("UPDATE orders SET status = ? WHERE id = ?", [status, req.params.id]);
        res.json({ message: 'Status updated' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/products/:id/stock', requireAuth, async (req, res) => {
    const { in_stock, stock_count } = req.body;
    try {
        usePostgres
            ? await sql`UPDATE products SET in_stock = ${in_stock}, stock_count = ${stock_count} WHERE id = ${req.params.id}`
            : db.run("UPDATE products SET in_stock = ?, stock_count = ? WHERE id = ?", [in_stock, stock_count, req.params.id]);
        res.json({ message: 'Stock updated' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/stats', requireAuth, async (req, res) => {
    try {
        if (usePostgres) {
            const orders = await sql`SELECT COUNT(*) as total_orders FROM orders`;
            const pending = await sql`SELECT COUNT(*) as pending_orders FROM orders WHERE status = 'pending'`;
            const unseen = await sql`SELECT COUNT(*) as unseen_orders FROM orders WHERE admin_seen = 0`;
            const revenue = await sql`SELECT SUM(p.price * o.quantity) as revenue FROM orders o JOIN products p ON o.product_id = p.id WHERE o.status = 'completed'`;
            res.json({
                total_orders: parseInt(orders[0].total_orders) || 0,
                pending_orders: parseInt(pending[0].pending_orders) || 0,
                unseen_orders: parseInt(unseen[0].unseen_orders) || 0,
                revenue: revenue[0].revenue ? parseFloat(revenue[0].revenue) : 0
            });
        } else {
            db.get("SELECT COUNT(*) as total_orders FROM orders", [], (err, orders) => {
                db.get("SELECT COUNT(*) as pending_orders FROM orders WHERE status = 'pending'", [], (err, pending) => {
                    db.get("SELECT COUNT(*) as unseen_orders FROM orders WHERE admin_seen = 0", [], (err, unseen) => {
                        db.get("SELECT SUM(price * quantity) as revenue FROM orders o JOIN products p ON o.product_id = p.id WHERE o.status = 'completed'", [], (err, revenue) => {
                            res.json({
                                total_orders: orders.total_orders,
                                pending_orders: pending.pending_orders,
                                unseen_orders: unseen.unseen_orders,
                                revenue: revenue.revenue || 0
                            });
                        });
                    });
                });
            });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Serve static files
app.use(express.static('public'));

// For local development
if (!process.env.VERCEL) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}

module.exports = app;
