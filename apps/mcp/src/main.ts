#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createVpaMcpServer } from './server.js';

const server = createVpaMcpServer();
await server.connect(new StdioServerTransport());
