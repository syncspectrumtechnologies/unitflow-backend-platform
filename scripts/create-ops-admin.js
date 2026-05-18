require('dotenv').config();
const bcrypt = require('bcrypt');
const prisma = require('../src/config/db');

(async () => {
  const email = process.env.BOOTSTRAP_OPS_EMAIL;
  const name = process.env.BOOTSTRAP_OPS_NAME || 'UnitFlow Ops Admin';
  const password = process.env.BOOTSTRAP_OPS_PASSWORD;

  if (!email || !password) {
    console.error('BOOTSTRAP_OPS_EMAIL and BOOTSTRAP_OPS_PASSWORD are required');
    process.exit(1);
  }

  const password_hash = await bcrypt.hash(password, 10);
  const user = await prisma.opsUser.upsert({
    where: { email: String(email).toLowerCase().trim() },
    update: { name, password_hash, status: 'ACTIVE' },
    create: { email: String(email).toLowerCase().trim(), name, password_hash, role: 'ADMIN', status: 'ACTIVE' }
  });

  console.log(`Ops admin ready: ${user.email}`);
  await prisma.$disconnect();
})();
