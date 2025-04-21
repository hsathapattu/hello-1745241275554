require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { Octokit } = require('@octokit/rest');
const path = require('path');
const fs = require('fs').promises;
const AdmZip = require('adm-zip');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(cors({ origin: 'http://localhost:3000', methods: ['GET', 'POST'] }));
app.use(express.static(__dirname));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
});
app.use(limiter);

// File upload setup
const upload = multer({ dest: 'uploads/' });

// Initialize GitHub API client with proper scopes
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

// In-memory storage for projects
const projects = [];

// Validate uploaded files
async function validateFiles(files) {
  const allowedExtensions = ['.html', '.css', '.js'];
  for (const file of files) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedExtensions.includes(ext)) {
      throw new Error(`අවසර නැති ගොනු වර්ගය: ${file.originalname}`);
    }
  }
  return true;
}

// Utility function to delay execution
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Check if GitHub Pages is already active
async function checkGitHubPages(owner, repo) {
  try {
    const { data } = await octokit.rest.repos.getPages({
      owner,
      repo
    });
    return data;
  } catch (err) {
    if (err.status === 404) {
      return null; // Pages not enabled yet
    }
    throw err;
  }
}

// Enable GitHub Pages for the repository with improved error handling and retries
async function enableGitHubPages(owner, repoName) {
  console.log(`Setting up GitHub Pages for ${owner}/${repoName}...`);
  
  // Wait for repository to be fully initialized
  await delay(5000);
  
  // First check if Pages is already enabled
  const pagesStatus = await checkGitHubPages(owner, repoName);
  
  if (pagesStatus) {
    console.log(`GitHub Pages already exists for ${owner}/${repoName}, updating settings...`);
    
    // Update existing Pages settings
    await octokit.rest.repos.updatePages({
      owner,
      repo: repoName,
      source: {
        branch: 'main',
      },
      build_type: 'workflow'
    });
  } else {
    console.log(`Creating new GitHub Pages for ${owner}/${repoName}...`);
    
    // Try to create Pages with the newer API
    try {
      await octokit.rest.repos.createPages({
        owner,
        repo: repoName,
        source: {
          branch: 'main',
        },
        build_type: 'workflow'
      });
    } catch (err) {
      console.warn(`Error with createPages: ${err.message}. Trying alternate method...`);
      
      // Fallback to direct request if the standard method fails
      try {
        await octokit.request('POST /repos/{owner}/{repo}/pages', {
          owner,
          repo: repoName,
          source: {
            branch: 'main',
          }
        });
      } catch (postErr) {
        if (postErr.status === 409) {
          // Already exists, which is fine
          console.log('Pages site already exists (409 conflict)');
        } else if (postErr.status === 422) {
          // Unprocessable entity, likely due to no content at root
          console.log('Creating index.html as GitHub Pages requires content at root');
          await createIndexHtmlIfNeeded(owner, repoName);
        } else {
          throw postErr;
        }
      }
    }
  }

  // Wait for GitHub Pages to be fully processed
  console.log('Waiting for GitHub Pages to be fully processed...');
  await delay(8000);

  // GitHub Pages URL format: https://<username>.github.io/<repoName>/
  return `https://${owner.toLowerCase()}.github.io/${repoName}/`;
}

// Create an index.html file if it doesn't exist (required for GitHub Pages)
async function createIndexHtmlIfNeeded(owner, repo) {
  try {
    // Check if index.html already exists
    try {
      await octokit.rest.repos.getContent({
        owner,
        repo,
        path: 'index.html'
      });
      console.log('index.html already exists');
      return; // File exists, no need to create
    } catch (err) {
      if (err.status !== 404) throw err;
      // 404 means file doesn't exist, continue to create it
    }
    
    // Create a basic index.html file
    const indexHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Website Project</title>
</head>
<body>
  <h1>Website Project</h1>
  <p>This site was deployed with GitHub Pages.</p>
</body>
</html>`;

    await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: 'index.html',
      message: 'Add index.html for GitHub Pages',
      content: Buffer.from(indexHtml).toString('base64'),
      branch: 'main'
    });
    
    console.log('Created index.html for GitHub Pages');
  } catch (err) {
    console.error('Error creating index.html:', err);
    throw err;
  }
}

// Create GitHub repository and upload files with improved workflow
async function createRepoAndUpload(projectName, email, files) {
  // Normalize repository name
  const sanitizedProjectName = projectName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const repoName = `${sanitizedProjectName}-${Date.now()}`;
  
  try {
    // Create repository (ensure it's public for GitHub Pages)
    const { data: repo } = await octokit.repos.createForAuthenticatedUser({
      name: repoName,
      description: `Website for ${projectName} by ${email}`,
      auto_init: true,
      private: false,
      has_issues: false,
      has_projects: false,
      has_wiki: false
    });
    console.log(`GitHub repository created: ${repo.full_name}`);

    // Use the repository name returned by GitHub
    const actualRepoName = repo.name;
    
    // Wait for repository initialization
    console.log('Waiting for repository to be fully available...');
    await delay(5000);

    // Check if we have an index.html in the uploads
    let hasIndexHtml = files.some(file => 
      file.originalname.toLowerCase() === 'index.html'
    );

    // Create index.html if needed
    if (!hasIndexHtml) {
      console.log('No index.html found in uploads, creating one...');
      const indexHtmlPath = path.join(__dirname, 'uploads', 'index.html');
      const indexHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${projectName}</title>
  <meta http-equiv="refresh" content="0;url=${files[0]?.originalname || ''}">
</head>
<body>
  <h1>${projectName}</h1>
  <p>Loading website...</p>
</body>
</html>`;
      
      await fs.writeFile(indexHtmlPath, indexHtml);
      files.push({
        path: indexHtmlPath,
        originalname: 'index.html'
      });
    }

    // Upload individual files to GitHub
    for (const file of files) {
      const fileContent = await fs.readFile(file.path);
      const fileBase64 = fileContent.toString('base64');
      
      await octokit.repos.createOrUpdateFileContents({
        owner: process.env.GITHUB_USERNAME,
        repo: actualRepoName,
        path: file.originalname,
        message: `Add ${file.originalname} for ${projectName}`,
        content: fileBase64,
        branch: 'main'
      });
      console.log(`Uploaded ${file.originalname} to ${actualRepoName}`);
    }
    
    // Create a workflow file to enable GitHub Actions for Pages
    const workflowYaml = `
name: Deploy to GitHub Pages

on:
  push:
    branches: [ main ]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: true

jobs:
  deploy:
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v3
      - name: Setup Pages
        uses: actions/configure-pages@v3
      - name: Upload artifact
        uses: actions/upload-pages-artifact@v1
        with:
          path: '.'
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v1
`;

    // Create the workflows directory and file
    await octokit.repos.createOrUpdateFileContents({
      owner: process.env.GITHUB_USERNAME,
      repo: actualRepoName,
      path: '.github/workflows/deploy-pages.yml',
      message: 'Add GitHub Pages workflow',
      content: Buffer.from(workflowYaml).toString('base64'),
      branch: 'main'
    });
    console.log(`Added GitHub Pages workflow to ${actualRepoName}`);

    // Enable GitHub Pages with retry logic
    let githubPagesUrl = null;
    let retries = 3;
    
    while (retries > 0) {
      try {
        githubPagesUrl = await enableGitHubPages(process.env.GITHUB_USERNAME, actualRepoName);
        break;
      } catch (err) {
        console.error(`GitHub Pages error (retries left: ${retries-1}):`, err.message);
        retries--;
        if (retries === 0) throw err;
        await delay(5000); // Wait before retry
      }
    }

    // Clean up temporary files
    for (const file of files) {
      try {
        await fs.unlink(file.path);
      } catch (err) {
        console.warn(`Could not delete temp file ${file.path}:`, err.message);
      }
    }

    return { 
      repoName: actualRepoName, 
      githubPagesUrl,
      repoUrl: repo.html_url
    };
  } catch (err) {
    console.error('GitHub API error:', err);
    throw new Error(`ගබඩාව සෑදීම අසාර්ථකයි: ${err.message}. Ensure GITHUB_TOKEN has sufficient permissions and GITHUB_USERNAME (${process.env.GITHUB_USERNAME}) is correct.`);
  }
}

// API endpoint for file upload
app.post('/upload', upload.array('files'), async (req, res) => {
  const { projectName, email } = req.body;
  const files = req.files;

  try {
    if (!projectName || !email || !files || !files.length) {
      return res.status(400).json({ error: 'කරුණාකර සියලු අනිවාර්ය ක්ෂේත්‍ර පුරවන්න සහ ගොනු උඡුගත කරන්න' });
    }

    await validateFiles(files);

    const { repoName, githubPagesUrl, repoUrl } = await createRepoAndUpload(projectName, email, files);

    // Store project metadata in memory
    projects.push({ projectName, email, repoName, githubPagesUrl, repoUrl });
    console.log('Current projects in memory:', projects);

    res.json({ 
      githubPagesUrl,
      repoUrl,
      message: 'Your site has been successfully deployed. GitHub Pages may take a few minutes to fully activate.'
    });
  } catch (err) {
    console.error('Error in /upload:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Server is running' });
});

// Start HTTP server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  // Ensure uploads directory exists
  try {
    await fs.mkdir('uploads', { recursive: true });
  } catch (err) {
    console.warn('Could not create uploads directory:', err.message);
  }
  
  console.log(`HTTP Server running on port ${PORT}`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Please free the port or change the PORT in server.js.`);
    process.exit(1);
  } else {
    console.error('Server error:', err.message);
    process.exit(1);
  }
});