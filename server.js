const http = require('http');
const app = require('./app');

const port = process.env.PORT || 3334;

const server = http.createServer(app);

server.listen(port);

console.log('server start at port: ',port)