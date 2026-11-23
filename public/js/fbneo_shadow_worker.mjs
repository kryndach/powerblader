// Browser Dedicated Module Web Worker for Off-Thread FBNeo Shadow Rollback
import {
  createShadowWorkerController
} from '../src/shadow_rollback_worker_core.mjs';

const ctrl = createShadowWorkerController((msg, xfer) => {
  if (xfer?.length) self.postMessage(msg, xfer);
  else self.postMessage(msg);
});

self.onmessage = (ev) => {
  ctrl.handleMessage(ev.data);
};
