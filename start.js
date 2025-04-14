// Helper script to properly start the webhook server
// with environment checks and database tests

import { spawn } from 'child_process';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { testConnection } from './services/supabaseClient.js';

// Load environment variables
dotenv.config();

// Get directory paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Log file setup
const LOG_FILE = path.join(DATA_DIR, 'webhook-server.log');
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

/**
 * Log a message to console and file
 */
function log(message, type = 'info') {
  const timestamp = new Date().toISOString();
  const prefix = type === 'error' ? '[ERROR]' : type === 'warn' ? '[WARNING]' : '[INFO]';
  const logMessage = `[${timestamp}] ${prefix} ${message}`;
  
  // Log to console
  if (type === 'error') {
    console.error(logMessage);
  } else {
    console.log(logMessage);
  }
  
  // Log to file
  logStream.write(logMessage + '\n');
}

// Check for required environment variables
const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY'
];

const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  log(`Missing required environment variables: ${missingEnvVars.join(', ')}`, 'error');
  log('Please check your .env file and restart the server', 'error');
  process.exit(1);
}

// Run database connection test
async function runDatabaseTest() {
  log('Testing database connection...');
  
  try {
    const result = await testConnection();
    
    if (!result.success) {
      log(`Database connection test failed: ${result.error}`, 'error');
      return false;
    }
    
    log('Database connection test successful');
    return true;
  } catch (error) {
    log(`Database test error: ${error.message}`, 'error');
    return false;
  }
}

// Start the server
function startServer() {
  log('Starting webhook server...');
  
  const serverProcess = spawn('node', ['server.js'], {
    stdio: 'inherit',
    shell: true
  });
  
  serverProcess.on('error', (error) => {
    log(`Server startup error: ${error.message}`, 'error');
  });
  
  serverProcess.on('exit', (code, signal) => {
    if (code !== 0) {
      log(`Server exited with code ${code} and signal ${signal}`, 'error');
    } else {
      log('Server stopped');
    }
  });
  
  // Handle termination signals
  process.on('SIGINT', () => {
    log('Received SIGINT. Shutting down gracefully...');
    serverProcess.kill('SIGINT');
  });
  
  process.on('SIGTERM', () => {
    log('Received SIGTERM. Shutting down gracefully...');
    serverProcess.kill('SIGTERM');
  });
  
  log('Server started successfully');
}

// Main startup sequence
async function startup() {
  log('\n====== WEBHOOK SERVER STARTUP ======\n');
  log(`Server starting in ${process.env.NODE_ENV || 'development'} mode`);
  
  // Test database connection before starting
  const dbConnected = await runDatabaseTest();
  
  if (!dbConnected) {
    log('WARNING: Database connection test failed. Server may not be able to store webhooks.', 'warn');
    
    // Ask for confirmation to continue
    if (process.env.FORCE_START !== 'true') {
      console.log('\nDatabase connection failed. Start server anyway? (y/n)');
      
      // Use readline to get user input
      const readline = await import('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      rl.question('> ', (answer) => {
        rl.close();
        
        if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
          startServer();
        } else {
          log('Server startup aborted by user');
          process.exit(0);
        }
      });
    } else {
      log('FORCE_START is set to true. Starting server despite database issues...');
      startServer();
    }
  } else {
    // Database is connected, start the server
    startServer();
  }
}

// Start the server
startup().catch(error => {
  log(`Unhandled startup error: ${error.message}`, 'error');
  process.exit(1);
}); 