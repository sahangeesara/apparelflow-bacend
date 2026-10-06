import 'dotenv/config';

import { createApp } from './app.ts';

const port = Number(process.env.PORT) || 4000;

try {
  const app = createApp();

  app.listen(port, () => {
    console.log(`ApparelFlow API listening on :${port}`);
  });
} catch (error) {
  console.error('SERVER START ERROR:', error);
}   