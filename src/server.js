const app = require('./app');
const config = require('./config');

app.listen(config.port, () => {
  console.log(`listening on ${config.port}`);
});
