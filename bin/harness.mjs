#!/usr/bin/env node
// Entry point for `npx harness` / `npm link`: loads the TypeScript sources through tsx.
import { register } from "tsx/esm/api";

register();
await import("../src/cli.ts");
