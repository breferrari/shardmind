#!/usr/bin/env node
import Pastel from 'pastel';

const app = new Pastel({
  importMeta: import.meta,
  name: 'shardmind',
  version: '0.1.0',
  description: 'Package manager for Obsidian vault templates',
});

await app.run();
