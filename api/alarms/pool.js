const sql = require('mssql');
const { dbConfig_PROD } = require('../../config');

// Alarm_Event lives on the SAME SQL Server as the historian (192.168.100.100);
// the handoff spec (alarm_event_api_spec.md) wrongly says 172.30.1.225 — do not
// "fix" it back. database must be 'Alarm_Event' so /dbhealth's
// FILEPROPERTY/sys.database_files queries run in the right DB context.
// ALARM_DB_USER/ALARM_DB_PASS allow switching to a db_datareader-only login
// later without touching config.js.
const alarmConfig = {
  ...dbConfig_PROD,
  user: process.env.ALARM_DB_USER || dbConfig_PROD.user,
  password: process.env.ALARM_DB_PASS || dbConfig_PROD.password,
  database: 'Alarm_Event',
  pool: { max: 5, min: 0, idleTimeoutMillis: 30000, acquireTimeoutMillis: 30000 },
};

const alarmPool = new sql.ConnectionPool(alarmConfig);
alarmPool.on('error', err => console.error('[Alarm_Event pool]', err));

// Lazy connect with retry: cache the connect promise, clear it on rejection so
// the next request re-attempts. mssql v11 allows connect() to be retried on the
// same ConnectionPool instance after a failed attempt; once connected, the
// tarn pool re-creates dropped connections on its own. Concurrent requests
// during an outage share one connect attempt (worst case one connectionTimeout
// wait before their 503).
let connectPromise = null;
function getAlarmPool() {
  if (!connectPromise) {
    connectPromise = alarmPool.connect()
      .then(() => {
        console.log('Connected to Alarm_Event (pool ready)');
        return alarmPool;
      })
      .catch(err => {
        console.error('Failed to connect to Alarm_Event:', err.message);
        connectPromise = null;
        throw err;
      });
  }
  return connectPromise;
}
getAlarmPool().catch(() => {}); // warm up at startup; never crash if the DB is down

// Route wrapper: connect failure -> 503, ConnectionError during the query -> 503,
// any other failure -> 500. All errors are JSON {error} per the alarm spec
// (unlike plants.js's plain-text 500 — deliberate difference).
function alarmRoute(handler) {
  return async (req, res) => {
    let pool;
    try {
      pool = await getAlarmPool();
    } catch (err) {
      return res.status(503).json({ error: 'Alarm_Event database unavailable' });
    }
    try {
      await handler(req, res, pool);
    } catch (err) {
      console.error('Alarm_Event query error:', err);
      if (err instanceof sql.ConnectionError) {
        return res.status(503).json({ error: 'Alarm_Event database unavailable' });
      }
      res.status(500).json({ error: 'Server error' });
    }
  };
}

module.exports = { getAlarmPool, alarmRoute };
