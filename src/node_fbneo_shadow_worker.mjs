// Node.js worker_threads Entry Point for Off-Thread FBNeo Shadow Rollback
import { parentPort } from 'node:worker_threads';
import {
  createShadowWorkerController
} from './shadow_rollback_worker_core.mjs';

const ctrl = createShadowWorkerController((msg, xfer) => {
  if (xfer?.length) parentPort.postMessage(msg, xfer);
  else parentPort.postMessage(msg);
});

parentPort.on('message', (data) => {
  ctrl.handleMessage(data);
});
