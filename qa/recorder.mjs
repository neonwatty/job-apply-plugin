#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrokerClient } from "./recorder/broker-client.mjs";
import {
  captureFullPagePng,
  inspectionHasSensitivePage,
} from "./recorder/capture.mjs";
import { commitCheckpoint } from "./recorder/checkpoint.mjs";
import { executeRecorderCli } from "./recorder/cli.mjs";
import { RecorderError } from "./recorder/errors.mjs";
import { decodeCapturedPng } from "./recorder/png.mjs";
import {
  CAPTURE_LIMITS,
  CHECKPOINT_KINDS,
  sanitizeObservedControl,
  validateCaptureResources,
  validateCheckpointKind,
  validateRecorderOptions,
  validateSafetyRevision,
} from "./recorder/resources.mjs";
import { isSensitivePage } from "./recorder/safety/common.mjs";

export {
  BrokerClient,
  CAPTURE_LIMITS,
  CHECKPOINT_KINDS,
  RecorderError,
  captureFullPagePng,
  commitCheckpoint,
  decodeCapturedPng,
  inspectionHasSensitivePage,
  isSensitivePage,
  sanitizeObservedControl,
  validateCaptureResources,
  validateCheckpointKind,
  validateRecorderOptions,
  validateSafetyRevision,
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  executeRecorderCli();
}
