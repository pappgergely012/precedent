#!/usr/bin/env node

const [command] = process.argv.slice(2);

if (command === "mine") {
  console.log("precedent mine: not implemented yet");
} else {
  console.log("Usage: precedent mine <owner/repo>");
}
