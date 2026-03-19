require('dotenv').config();
const { sendTrackingUpdate } = require('./index');

// Edit these two lines then run: node track.js

const ORDER_ID = 'CAKE1234567890'; // paste the order ID from Firebase
const STATUS   = 'baking';        // baking / decorating / dispatched / delivered

sendTrackingUpdate(ORDER_ID, STATUS)
  .then(() => {
    console.log('Done! Customer has been notified.');
    process.exit(0);
  })
  .catch(err => {
    console.error('Failed:', err.message);
    process.exit(1);
  });