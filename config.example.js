// Copy this file to config.js and fill in the real credentials (config.js is
// gitignored). Values can also be supplied via environment variables:
// DB_USER, DB_PASSWORD, DB_SERVER.
const dbConfig_PROD = {
    user: process.env.DB_USER || 'YOUR_DB_USER',
    password: process.env.DB_PASSWORD || 'YOUR_DB_PASSWORD',
    server: process.env.DB_SERVER || '192.168.100.100',
    database: '',
    options: {
      encrypt: false,                 // Not Azure
      trustServerCertificate: true,   // Internal network — skip TLS cert check, eliminates SSL handshake overhead
      enableArithAbort: true,         // Required by modern mssql drivers for correct behavior & better performance
    },
    connectionTimeout: 15000,         // ms — how long to wait to establish a connection
    requestTimeout: 60000,            // ms — how long a query is allowed to run before timeout
    pool: {
      max: 20,                        // Max concurrent connections (default was 10)
      min: 2,                         // Keep 2 connections warm — avoids cold-connect delay on first requests
      idleTimeoutMillis: 30000,       // Close idle connections after 30s
      acquireTimeoutMillis: 30000,    // Throw if a pool slot isn't free within 30s (prevents queue pile-up)
    }
  };

module.exports = {dbConfig_PROD};
