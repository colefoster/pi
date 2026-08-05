#!/usr/bin/env node
// pi-tui — terminal client for the pi harness.
// Talks directly to the harness (HTTP + WS, default :5179), the same protocol
// pi-web uses. Override the target with HARNESS_URL.
//
//   HARNESS_URL=http://localhost:5179 node cli.mjs
//
import React from "react";
import { render } from "ink";
import { App } from "./src/app.mjs";

const HARNESS_URL = (process.env.HARNESS_URL || "http://localhost:5179").replace(/\/$/, "");

// Ink owns the alternate screen buffer; a clean exit restores the terminal.
const { waitUntilExit } = render(React.createElement(App, { harnessUrl: HARNESS_URL }), {
  exitOnCtrlC: false, // we handle Ctrl+C ourselves so modals can cancel first
});

waitUntilExit().then(() => process.exit(0));
