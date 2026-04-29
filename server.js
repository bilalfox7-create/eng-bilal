const express = require('express');
const session = require('express-session');
const path = require('path');
const { initDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'eng-ieshat-secret-key-2025',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use('/auth', require('./routes/auth'));
app.use('/api',  require('./routes/api'));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDb();
app.listen(PORT, () => console.log(`🚀 Server ready → http://localhost:${PORT}`));
