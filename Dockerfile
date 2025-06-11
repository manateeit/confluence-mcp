# Use Node.js 18 LTS
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Set environment to skip Puppeteer download during install
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Install dependencies including dev dependencies for build
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Remove dev dependencies
RUN npm ci --only=production && npm cache clean --force

# Create data directory for volume mount
RUN mkdir -p /data

# Expose port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
