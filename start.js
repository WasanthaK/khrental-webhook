// Helper script to properly start the webhook server
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

// Logger
function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  log(`Creating data directory: ${dataDir}`);
  fs.mkdirSync(dataDir, { recursive: true });
}

// Check if port 3030 is already in use
function checkPort(port) {
  return new Promise((resolve) => {
    const server = http.createServer();
    
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        log(`❌ Port ${port} is already in use. Another process may be running.`);
        resolve(false);
      }
    });
    
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    
    server.listen(port);
  });
}

async function startServer() {
  try {
    log('Starting webhook server...');
    
    // Check if port is available
    const portAvailable = await checkPort(3030);
    
    if (!portAvailable) {
      log('Attempting to kill any existing Node.js processes...');
      
      try {
        if (process.platform === 'win32') {
          const { execSync } = require('child_process');
          execSync('taskkill /F /IM node.exe', { stdio: 'ignore' });
          log('Killed existing Node.js processes');
        } else {
          log('Please manually stop any running Node.js processes and try again');
          process.exit(1);
        }
      } catch (error) {
        log('No existing Node.js processes found or unable to kill them');
      }
      
      // Wait a moment for the port to be released
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Set environment to production
    const env = { ...process.env, NODE_ENV: 'production' };
    
    // Start the server process
    log('Launching server in production mode...');
    const serverProcess = spawn('node', ['server.js'], {
      env,
      stdio: 'inherit',
      cwd: __dirname
    });
    
    serverProcess.on('error', (err) => {
      log(`❌ Failed to start server: ${err.message}`);
      process.exit(1);
    });
    
    // The server is now running (stdio is inherited, so you'll see its output)
    // No need to explicitly listen for stdout/stderr
    
    log('Server process started. Press Ctrl+C to stop.');
    
    // Handle process termination
    process.on('SIGINT', () => {
      log('Shutting down...');
      serverProcess.kill();
      process.exit(0);
    });
    
    // Keep the process running
    serverProcess.on('close', (code) => {
      log(`Server process exited with code ${code}`);
      process.exit(code);
    });
    
  } catch (error) {
    log(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

startServer(); 