import express from 'express';
import sqlite3 from 'sqlite3';

const app = express();
app.use(express.json());

const dbPath = './events.db';
const db = new sqlite3.Database(dbPath);

// Create events table if it doesn't exist
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    date TEXT NOT NULL,
    metadata TEXT
  )`);
});

// POST /event - receive events
app.post('/event', (req, res) => {
  const { eventType, metadata } = req.body;
  
  // Validate required fields
  if (!eventType || typeof eventType !== 'string') {
    return res.status(400).json({ error: 'eventType is required and must be a string' });
  }
  
  const date = new Date().toISOString().split('T')[0];
  
  db.run(
    `INSERT INTO events (event_type, date, metadata) VALUES (?, ?, ?)`,
    [eventType, date, JSON.stringify(metadata || {})],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      res.json({ success: true, id: this.lastID });
    }
  );
});

// GET /summary - counts grouped by event type and date
app.get('/summary', (req, res) => {
  db.all(
    `SELECT event_type, date, COUNT(*) as count 
     FROM events 
     GROUP BY event_type, date 
     ORDER BY event_type, date`,
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      res.json(rows);
    }
  );
});

// GET /export - downloadable CSV of all events
app.get('/export', (req, res) => {
  db.all(
    `SELECT id, event_type, timestamp, date, metadata 
     FROM events 
     ORDER BY id`,
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      
      // Create CSV content
      const headers = ['id', 'event_type', 'timestamp', 'date', 'metadata'];
      const csvRows = rows.map(row => {
        return [
          row.id,
          row.event_type,
          row.timestamp,
          row.date,
          JSON.stringify(row.metadata)
        ].join(',');
      });
      
      const csvContent = [headers.join(','), ...csvRows].join('\n');
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=events.csv');
      res.send(csvContent);
    }
  );
});

// Start server (only if this file is run directly)
if (import.meta.url === `file://${process.argv[1]}`) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

export { app, db };