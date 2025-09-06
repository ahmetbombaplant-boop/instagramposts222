// app/all-in-one.js  (CommonJS, безопасно для любого кода)
require('./server');  // Express API (слушает PORT от Render)
require('./worker');  // BullMQ worker (фоновая очередь)
require('./bot');     // Telegram bot (polling)

console.log('[all-in-one] server + worker + bot started');
