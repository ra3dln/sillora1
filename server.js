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

// Database setup
const usePostgres = !!(process.env.POSTGRES_URL || process.env.DATABASE_URL);
let pool, db;

if (usePostgres) {
    const { Pool } = require('pg');
    pool = new Pool({
        connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    console.log('Using Postgres database');
} else {
    const sqlite3 = require('sqlite3').verbose();
    db = new sqlite3.Database('database.sqlite', (err) => {
        if (err) console.error('Error opening database:', err.message);
        else console.log('Connected to SQLite database');
    });
}

// Initialize database
function initDB() {
    if (usePostgres) {
        pool.query(`
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT,
                price NUMERIC NOT NULL, original_price NUMERIC, image TEXT,
                in_stock INTEGER DEFAULT 1, stock_count INTEGER DEFAULT 5,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `).then(() => pool.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY, customer_name TEXT NOT NULL, phone TEXT NOT NULL,
                address TEXT NOT NULL, product_id INTEGER, quantity INTEGER DEFAULT 1,
                status TEXT DEFAULT 'pending', admin_seen INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `)).then(() => pool.query(`
            CREATE TABLE IF NOT EXISTS admins (
                id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL
            )
        `)).then(() => pool.query('SELECT * FROM products WHERE id = 1')).then(prod => {
            if (prod.rows.length === 0) {
                pool.query(
                    `INSERT INTO products (name, description, price, original_price, image, stock_count)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    ['SILLORA Perfume', 'عطر فاخر بمزيج من البن والفانيليا والزهور البيضاء. ثبات عالٍ وفوحان يدوم طوال اليوم.', 130, 150, '/images/perfume1.png', 5]
                );
            }
        }).then(() => pool.query("SELECT * FROM admins WHERE username = 'admin'")).then(adm => {
            if (adm.rows.length === 0) {
                const hashedPassword = bcrypt.hashSync('3/5/2026', 10);
                pool.query("INSERT INTO admins (username, password) VALUES ($1, $2)", ['admin', hashedPassword]);
            }
        }).catch(err => console.error('DB Init Error:', err.message));
    } else {
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT,
                price REAL NOT NULL, original_price REAL, image TEXT, in_stock INTEGER DEFAULT 1,
                stock_count INTEGER DEFAULT 5, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
            db.run(`CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT, customer_name TEXT NOT NULL, phone TEXT NOT NULL,
                address TEXT NOT NULL, product_id INTEGER, quantity INTEGER DEFAULT 1,
                status TEXT DEFAULT 'pending', admin_seen INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
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
app.get('/api/products', (req, res) => {
    if (usePostgres) {
        pool.query('SELECT * FROM products').then(result => res.json(result.rows)).catch(err => res.status(500).json({ error: err.message }));
    } else {
        db.all("SELECT * FROM products", [], (err, rows) => err ? res.status(500).json({ error: err.message }) : res.json(rows));
    }
});

app.get('/api/products/:id', (req, res) => {
    if (usePostgres) {
        pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]).then(result => res.json(result.rows[0])).catch(err => res.status(500).json({ error: err.message }));
    } else {
        db.get("SELECT * FROM products WHERE id = ?", [req.params.id], (err, row) => err ? res.status(500).json({ error: err.message }) : res.json(row));
    }
});

app.post('/api/orders', (req, res) => {
    const { customer_name, phone, address, product_id, quantity } = req.body;
    if (!customer_name || !phone || !address) return res.status(400).json({ error: 'All fields are required' });
    if (usePostgres) {
        pool.query(
            `INSERT INTO orders (customer_name, phone, address, product_id, quantity) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [customer_name, phone, address, product_id || 1, quantity || 1]
        ).then(result => {
            pool.query('UPDATE products SET stock_count = stock_count - $1 WHERE id = $2', [quantity || 1, product_id || 1]);
            res.json({ id: result.rows[0].id, message: 'Order placed successfully!' });
        }).catch(err => res.status(500).json({ error: err.message }));
    } else {
        db.run(`INSERT INTO orders (customer_name, phone, address, product_id, quantity) VALUES (?, ?, ?, ?, ?)`,
            [customer_name, phone, address, product_id || 1, quantity || 1],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                db.run("UPDATE products SET stock_count = stock_count - ? WHERE id = ?", [quantity || 1, product_id || 1]);
                res.json({ id: this.lastID, message: 'Order placed successfully!' });
            });
    }
});

// ========== ADMIN ROUTES ==========
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (usePostgres) {
        pool.query('SELECT * FROM admins WHERE username = $1', [username]).then(result => {
            const user = result.rows[0];
            if (!user) return res.status(401).json({ error: 'Invalid credentials' });
            if (bcrypt.compareSync(password, user.password)) {
                req.session.admin = { id: user.id, username: user.username };
                req.session.save(() => res.json({ message: 'Login successful', admin: req.session.admin }));
            } else {
                res.status(401).json({ error: 'Invalid credentials' });
            }
        }).catch(err => res.status(500).json({ error: err.message }));
    } else {
        db.get("SELECT * FROM admins WHERE username = ?", [username], (err, user) => {
            if (err || !user) return res.status(401).json({ error: 'Invalid credentials' });
            if (bcrypt.compareSync(password, user.password)) {
                req.session.admin = { id: user.id, username: user.username };
                req.session.save(() => res.json({ message: 'Login successful', admin: req.session.admin }));
            } else {
                res.status(401).json({ error: 'Invalid credentials' });
            }
        });
    }
});

app.post('/api/admin/logout', (req, res) => {
    req.session.destroy(() => res.json({ message: 'Logged out' }));
});

app.get('/api/admin/me', requireAuth, (req, res) => {
    res.json({ admin: req.session.admin });
});

app.get('/api/admin/orders', requireAuth, (req, res) => {
    if (usePostgres) {
        pool.query(`SELECT o.*, p.name as product_name, p.price as product_price FROM orders o LEFT JOIN products p ON o.product_id = p.id ORDER BY o.created_at DESC`)
            .then(result => res.json(result.rows)).catch(err => res.status(500).json({ error: err.message }));
    } else {
        db.all(`SELECT o.*, p.name as product_name, p.price as product_price FROM orders o LEFT JOIN products p ON o.product_id = p.id ORDER BY o.created_at DESC`, [], (err, rows) => err ? res.status(500).json({ error: err.message }) : res.json(rows));
    }
});

app.put('/api/admin/orders/:id/seen', requireAuth, (req, res) => {
    if (usePostgres) {
        pool.query('UPDATE orders SET admin_seen = 1 WHERE id = $1', [req.params.id]).then(() => res.json({ message: 'Order marked as seen' })).catch(err => res.status(500).json({ error: err.message }));
    } else {
        db.run("UPDATE orders SET admin_seen = 1 WHERE id = ?", [req.params.id], (err) => err ? res.status(500).json({ error: err.message }) : res.json({ message: 'Order marked as seen' }));
    }
});

app.put('/api/admin/orders/:id/status', requireAuth, (req, res) => {
    const { status } = req.body;
    if (usePostgres) {
        pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, req.params.id]).then(() => res.json({ message: 'Status updated' })).catch(err => res.status(500).json({ error: err.message }));
    } else {
        db.run("UPDATE orders SET status = ? WHERE id = ?", [status, req.params.id], (err) => err ? res.status(500).json({ error: err.message }) : res.json({ message: 'Status updated' }));
    }
});

app.put('/api/admin/products/:id/stock', requireAuth, (req, res) => {
    const { in_stock, stock_count } = req.body;
    if (usePostgres) {
        pool.query('UPDATE products SET in_stock = $1, stock_count = $2 WHERE id = $3', [in_stock, stock_count, req.params.id]).then(() => res.json({ message: 'Stock updated' })).catch(err => res.status(500).json({ error: err.message }));
    } else {
        db.run("UPDATE products SET in_stock = ?, stock_count = ? WHERE id = ?", [in_stock, stock_count, req.params.id], (err) => err ? res.status(500).json({ error: err.message }) : res.json({ message: 'Stock updated' }));
    }
});

app.get('/api/admin/stats', requireAuth, (req, res) => {
    if (usePostgres) {
        pool.query('SELECT COUNT(*) as total_orders FROM orders').then(orders => {
            pool.query("SELECT COUNT(*) as pending_orders FROM orders WHERE status = 'pending'").then(pending => {
                pool.query('SELECT COUNT(*) as unseen_orders FROM orders WHERE admin_seen = 0').then(unseen => {
                    pool.query("SELECT SUM(p.price * o.quantity) as revenue FROM orders o JOIN products p ON o.product_id = p.id WHERE o.status = 'completed'").then(revenue => {
                        res.json({
                            total_orders: parseInt(orders.rows[0].total_orders) || 0,
                            pending_orders: parseInt(pending.rows[0].pending_orders) || 0,
                            unseen_orders: parseInt(unseen.rows[0].unseen_orders) || 0,
                            revenue: revenue.rows[0].revenue ? parseFloat(revenue.rows[0].revenue) : 0
                        });
                    });
                });
            });
        }).catch(err => res.status(500).json({ error: err.message }));
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
