const core = require('./core.js');
const dispatch = require('./dispatch.js');
const records = require('./records.js');
const doj = require('./doj.js');
const radio = require('./radio.js');
const alarms = require('./alarms.js');
// kolejność: core (middleware w app.locals.mdt) -> moduły zależne
function register(app, deps) { core.register(app, deps); dispatch.register(app, deps); records.register(app, deps); doj.register(app, deps); radio.register(app, deps); alarms.register(app, deps); }
async function migrate(pool) { await core.migrate(pool); await dispatch.migrate(pool); await records.migrate(pool); await doj.migrate(pool); await radio.migrate(pool); await alarms.migrate(pool); }
module.exports = { register, migrate };
