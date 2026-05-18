require('dotenv').config();
const prisma = require('../src/config/db');
const { applyLifecycleMaintenance } = require('../src/services/subscriptionService');

(async () => {
  try {
    await applyLifecycleMaintenance();
    console.log('Subscription maintenance completed');
  } finally {
    await prisma.$disconnect();
  }
})();
