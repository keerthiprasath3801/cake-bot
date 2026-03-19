require('dotenv').config();
const express = require('express');
const twilio  = require('twilio');
const admin   = require('firebase-admin');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── INITIALISE SERVICES ──────────────────────────────────────

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY_JSON);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── ORDER FLOW SETUP ─────────────────────────────────────────

const sessions = {};

const STEPS = ['kg', 'flavour', 'date', 'time', 'cake_text', 'custom_design'];

const QUESTIONS = {
  kg:
    'How many kg do you need?\n(e.g. 1, 1.5, 2)',
  flavour:
    'What flavour would you like?\n\n' +
    '1. Chocolate\n' +
    '2. Vanilla\n' +
    '3. Strawberry\n' +
    '4. Red Velvet\n' +
    '5. Butterscotch\n\n' +
    'Type your choice from the list or any other flavour.',
  date:
    'What is the delivery date?\n(e.g. 25 March 2026)',
  time:
    'What time should we deliver?\n(e.g. 6:00 PM)',
  cake_text:
    'What should we write on the cake?\n\nType your message or type NONE if nothing.',
  custom_design:
    'Do you need a custom cake design?\n\nReply *YES* or *NO*'
};

// ── VALIDATION ───────────────────────────────────────────────

function validate(key, value) {
  switch (key) {
    case 'kg':
      return !isNaN(parseFloat(value)) && parseFloat(value) > 0;
    case 'flavour':
      return value.length >= 2;
    case 'date':
      return value.length >= 4;
    case 'time':
      return value.length >= 3;
    case 'cake_text':
      return value.length >= 1;
    case 'custom_design':
      return ['YES', 'NO'].includes(value.toUpperCase());
    default:
      return true;
  }
}

function validationError(key) {
  switch (key) {
    case 'kg':
      return 'Please enter a valid weight in kg.\n(e.g. 1, 1.5, 2)';
    case 'flavour':
      return 'Please type a valid flavour name.';
    case 'date':
      return 'Please enter a valid delivery date.\n(e.g. 25 March 2026)';
    case 'time':
      return 'Please enter a valid delivery time.\n(e.g. 6:00 PM)';
    case 'cake_text':
      return 'Please type the message for the cake or type NONE.';
    case 'custom_design':
      return 'Please reply with *YES* or *NO* only.';
    default:
      return 'Invalid input. Please try again.';
  }
}

// ── INCOMING WHATSAPP MESSAGES ───────────────────────────────

app.post('/webhook', async (req, res) => {
  res.status(200).end();

  const from = req.body.From?.replace('whatsapp:+', '');
  const text = req.body.Body?.trim();

  if (!from || !text) return;

  if (!sessions[from]) sessions[from] = { step: 0, order: {} };
  const s = sessions[from];

  try {

    // ── WAITING FOR CONFIRM OR CANCEL ──
    if (s.step === 'confirm') {
      const reply = text.toUpperCase();

      if (reply === 'CONFIRM') {
        await placeOrder(from, s.order);
        delete sessions[from];

      } else if (reply === 'CANCEL') {
        await send(from,
          'Your order has been cancelled.\n\n' +
          'Send any message to start a new order!'
        );
        delete sessions[from];

      } else {
        await send(from,
          'Please reply *CONFIRM* to place your order or *CANCEL* to cancel.'
        );
      }
      return;
    }

    // ── FIRST MESSAGE — GREET CUSTOMER ──
    if (s.step === 0) {
      await send(from,
        'Welcome to *Velvet Cakes!*\n\n' +
        'I will help you place your cake order in just a few steps.\n\n' +
        QUESTIONS.kg
      );
      s.step = 1;
      return;
    }

    // ── COLLECT ORDER DETAILS ──
    const key = STEPS[s.step - 1];

    // Validate input before moving forward
    if (!validate(key, text)) {
      await send(from, validationError(key));
      return;
    }

    s.order[key] = text;

    // Custom design → hand off to seller
    if (key === 'custom_design' && text.toUpperCase() === 'YES') {
      await send(from,
        'Our cake designer will contact you to discuss your custom design!\n\n' +
        'You can also reach us directly:\n' +
        'https://wa.me/' + process.env.SELLER_PHONE + '\n\n' +
        'Your other order details have been saved.'
      );
      await notifySeller(from, s.order, true);
      delete sessions[from];
      return;
    }

    // Move to next question
    if (s.step < STEPS.length) {
      await send(from, QUESTIONS[STEPS[s.step]]);
      s.step++;

    } else {
      // All questions done — show summary
      const o = s.order;
      const priceEst = (parseFloat(o.kg) * parseInt(process.env.PRICE_PER_KG)).toFixed(0);

      await send(from,
        'Here is your order summary:\n\n' +
        'Cake weight  : ' + o.kg + ' kg\n' +
        'Flavour      : ' + o.flavour + '\n' +
        'Delivery date: ' + o.date + '\n' +
        'Delivery time: ' + o.time + '\n' +
        'Text on cake : ' + o.cake_text + '\n' +
        'Custom design: No\n\n' +
        'Estimated price: Rs.' + priceEst + '\n\n' +
        'Reply *CONFIRM* to place your order\n' +
        'Reply *CANCEL* to start over'
      );
      s.step = 'confirm';
    }

  } catch (err) {
    console.error('Error:', err.message);
    await send(from, 'Sorry, something went wrong. Please send any message to try again.');
  }
});

// ── PLACE CONFIRMED ORDER ────────────────────────────────────

async function placeOrder(phone, order) {
  const orderId = 'CAKE' + Date.now();

  await db.collection('orders').doc(orderId).set({
    orderId,
    customer:      phone,
    kg:            order.kg,
    flavour:       order.flavour,
    date:          order.date,
    time:          order.time,
    cake_text:     order.cake_text,
    custom_design: false,
    status:        'received',
    createdAt:     new Date()
  });

  await send(phone,
    'Your order is confirmed!\n\n' +
    'Order ID: *' + orderId + '*\n\n' +
    'We will contact you shortly for payment.\n\n' +
    'You will receive updates as your cake gets ready!\n\n' +
    'Thank you for choosing Velvet Cakes!'
  );

  await notifySeller(phone, order, false, orderId);
}

// ── NOTIFY SELLER ────────────────────────────────────────────

async function notifySeller(phone, order, isCustom, orderId = '') {
  let msg;

  if (isCustom) {
    msg =
      'NEW CUSTOM ORDER\n\n' +
      'Customer  : +' + phone + '\n' +
      'Kg        : ' + order.kg + '\n' +
      'Flavour   : ' + order.flavour + '\n' +
      'Date      : ' + order.date + '\n' +
      'Time      : ' + order.time + '\n' +
      'On cake   : ' + order.cake_text + '\n\n' +
      'Contact the customer for custom design.';
  } else {
    msg =
      'NEW ORDER CONFIRMED\n\n' +
      'Order ID  : ' + orderId + '\n' +
      'Customer  : +' + phone + '\n' +
      'Kg        : ' + order.kg + '\n' +
      'Flavour   : ' + order.flavour + '\n' +
      'Date      : ' + order.date + '\n' +
      'Time      : ' + order.time + '\n' +
      'On cake   : ' + order.cake_text;
  }

  await send(process.env.SELLER_PHONE, msg);
}

// ── SEND WHATSAPP MESSAGE ────────────────────────────────────

async function send(to, body) {
  await twilioClient.messages.create({
    from: 'whatsapp:' + process.env.TWILIO_WHATSAPP_NUMBER,
    to:   'whatsapp:+' + to,
    body
  });
}

// ── TRACKING UPDATES ─────────────────────────────────────────

async function sendTrackingUpdate(orderId, status) {
  const messages = {
    baking:
      'Your cake is being baked right now!',
    decorating:
      'We are adding the final decorations to your cake!',
    dispatched:
      'Your cake is out for delivery! It will reach you soon.',
    delivered:
      'Your cake has been delivered!\n\nEnjoy every bite! Thank you for choosing Velvet Cakes.'
  };

  const doc = await db.collection('orders').doc(orderId).get();

  if (!doc.exists) {
    console.log('Order not found:', orderId);
    return;
  }

  await db.collection('orders').doc(orderId).update({
    status,
    updatedAt: new Date()
  });

  await send(doc.data().customer, messages[status]);
  console.log('Tracking update sent —', orderId, '—', status);
}

// ── START SERVER ─────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Cake bot running on port ' + PORT));

module.exports = { sendTrackingUpdate };