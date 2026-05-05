const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const app = express();

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'sillora_secret_key_2024',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

// Database setup - use /tmp for Vercel
const dbPath = '/tmp/database.sqlite';
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('DB Error:', err.message);
    else console.log('DB Connected');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        price REAL NOT NULL,
        original_price REAL,
        image TEXT,
        in_stock INTEGER DEFAULT 1,
        stock_count INTEGER DEFAULT 5,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        address TEXT NOT NULL,
        product_id INTEGER,
        quantity INTEGER DEFAULT 1,
        status TEXT DEFAULT 'pending',
        admin_seen INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL
    )`);

    // Insert defaults
    db.get("SELECT * FROM products WHERE id = 1", (err, row) => {
        if (!row) {
            db.run(`INSERT INTO products (name, description, price, original_price, image, stock_count) 
                    VALUES (?, ?, ?, ?, ?, ?)`, 
                ['SILLORA Black Opium', 
                 'عطر فاخر بمزيج من البن والفانيليا والزهور البيضاء. ثبات عالٍ وفوحان يدوم طوال اليوم.',
                 120, 150, '/images/perfume1.png', 5]);
        }
    });

    db.get("SELECT * FROM admins WHERE username = 'admin'", (err, row) => {
        if (!row) {
            const hashedPassword = bcrypt.hashSync('admin123', 10);
            db.run("INSERT INTO admins (username, password) VALUES (?, ?)", ['admin', hashedPassword]);
        }
    });
});

// Auth middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.admin) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}

// ========== PUBLIC ROUTES ==========
app.get('/api/products', (req, res) => {
    db.all("SELECT * FROM products", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/products/:id', (req, res) => {
    db.get("SELECT * FROM products WHERE id = ?", [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row);
    });
});

app.post('/api/orders', (req, res) => {
    const { customer_name, phone, address, product_id, quantity } = req.body;
    if (!customer_name || !phone || !address) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    db.run(`INSERT INTO orders (customer_name, phone, address, product_id, quantity) 
            VALUES (?, ?, ?, ?, ?)`,
        [customer_name, phone, address, product_id || 1, quantity || 1],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            db.run("UPDATE products SET stock_count = stock_count - ? WHERE id = ?", 
                [quantity || 1, product_id || 1]);
            res.json({ id: this.lastID, message: 'Order placed successfully!' });
        }
    );
});

// ========== ADMIN ROUTES ==========
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM admins WHERE username = ?", [username], (err, user) => {
        if (err || !user) return res.status(401).json({ error: 'Invalid credentials' });
        if (bcrypt.compareSync(password, user.password)) {
            req.session.admin = { id: user.id, username: user.username };
            res.json({ message: 'Login successful', admin: req.session.admin });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    });
});

app.post('/api/admin/logout', (req, res) => {
    req.session.destroy();
    res.json({ message: 'Logged out' });
});

app.get('/api/admin/me', requireAuth, (req, res) => {
    res.json({ admin: req.session.admin });
});

app.get('/api/admin/orders', requireAuth, (req, res) => {
    db.all(`SELECT o.*, p.name as product_name, p.price as product_price 
            FROM orders o LEFT JOIN products p ON o.product_id = p.id 
            ORDER BY o.created_at DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.put('/api/admin/orders/:id/seen', requireAuth, (req, res) => {
    db.run("UPDATE orders SET admin_seen = 1 WHERE id = ?", [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Order marked as seen' });
    });
});

app.put('/api/admin/orders/:id/status', requireAuth, (req, res) => {
    const { status } = req.body;
    db.run("UPDATE orders SET status = ? WHERE id = ?", [status, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Status updated' });
    });
});

app.put('/api/admin/products/:id/stock', requireAuth, (req, res) => {
    const { in_stock, stock_count } = req.body;
    db.run("UPDATE products SET in_stock = ?, stock_count = ? WHERE id = ?", 
        [in_stock, stock_count, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Stock updated' });
    });
});

app.get('/api/admin/stats', requireAuth, (req, res) => {
    db.get("SELECT COUNT(*) as total_orders FROM orders", [], (err, orders) => {
        db.get("SELECT COUNT(*) as pending_orders FROM orders WHERE status = 'pending'", [], (err, pending) => {
            db.get("SELECT COUNT(*) as unseen_orders FROM orders WHERE admin_seen = 0", [], (err, unseen) => {
                db.get("SELECT SUM(price * quantity) as revenue FROM orders o JOIN products p ON o.product_id = p.id WHERE o.status = 'completed'", [], (err, revenue) => {
                    res.json({
                        total_orders: orders ? orders.total_orders : 0,
                        pending_orders: pending ? pending.pending_orders : 0,
                        unseen_orders: unseen ? unseen.unseen_orders : 0,
                        revenue: revenue && revenue.revenue ? revenue.revenue : 0
                    });
                });
            });
        });
    });
});

module.exports = app;
