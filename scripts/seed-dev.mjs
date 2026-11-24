process.env.NEW_ACCOUNT_COOLDOWN_MIN = '0'
process.env.SIGNUP_PER_IP_HOUR = '1000'
const { migrate, one } = await import('../backend/src/db.js')
const { seed } = await import('../backend/test/fixtures/seed.js')
await migrate()
await seed({ quiet: true })
const row = await one('SELECT id FROM drops LIMIT 1')
console.log('seeded', row)