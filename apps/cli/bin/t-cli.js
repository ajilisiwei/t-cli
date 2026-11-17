#!/usr/bin/env node
import 'dotenv/config'; // 加载 .env 文件（如果存在）
import { startRepl } from '../src/repl.js';

startRepl();
