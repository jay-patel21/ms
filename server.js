const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const dns = require('dns').promises;

const app = express();
const PORT = process.env.PORT || 3000;
const POD_NAME = process.env.POD_NAME || 'unknown';
const POD_IP = process.env.POD_IP || 'unknown';
const NAMESPACE = process.env.NAMESPACE || 'default';
const SERVICE_DNS_SUFFIX = process.env.SERVICE_DNS_SUFFIX || 'svc.cluster.local';
const APP_NAME = process.env.APP_NAME || 'node-kube-app';
const ENVIRONMENT = process.env.ENVIRONMENT || 'development';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const PEER_SERVICE_NAME = process.env.PEER_SERVICE_NAME || `${APP_NAME}-internal`; // headless service name
const PEER_SERVICE_PORT = process.env.PEER_SERVICE_PORT || PORT;
const DISCOVERY_INTERVAL_MS = parseInt(process.env.DISCOVERY_INTERVAL_MS || '10000', 10);
const REPLICA_TTL_MS = parseInt(process.env.REPLICA_TTL_MS || '60000', 10);
const MESSAGE_RETENTION = parseInt(process.env.MESSAGE_RETENTION || '100', 10);
const BROADCAST_TIMEOUT = parseInt(process.env.BROADCAST_TIMEOUT || '5000', 10);
const SERVICE_ROLE = (process.env.SERVICE_ROLE || 'message').toLowerCase();
const NOTIFICATION_TARGET_SERVICE = process.env.NOTIFICATION_TARGET_SERVICE;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// In-memory storage for demo purposes
let messages = [];
let notifications = [];
const replicaRegistry = new Map();

const peerServiceFQDN = `${PEER_SERVICE_NAME}.${NAMESPACE}.${SERVICE_DNS_SUFFIX}`;

const log = {
  info: (...args) => console.log(`[INFO]`, ...args),
  warn: (...args) => console.warn(`[WARN]`, ...args),
  error: (...args) => console.error(`[ERROR]`, ...args),
  debug: (...args) => {
    if (LOG_LEVEL === 'debug') {
      console.debug(`[DEBUG]`, ...args);
    }
  },
};

const trimMessages = () => {
  if (messages.length > MESSAGE_RETENTION) {
    messages = messages.slice(messages.length - MESSAGE_RETENTION);
  }
  if (notifications.length > MESSAGE_RETENTION) {
    notifications = notifications.slice(notifications.length - MESSAGE_RETENTION);
  }
};

const upsertReplica = ({
  pod,
  ip,
  address,
  serviceName,
}) => {
  const replicaAddress = address || ip || serviceName;
  if (!replicaAddress) {
    return null;
  }

  if (replicaAddress === POD_IP || pod === POD_NAME) {
    return null;
  }

  const key = pod || serviceName || ip || replicaAddress;
  const stored = replicaRegistry.get(key) || {};
  const updated = {
    id: key,
    pod: pod || stored.pod || key,
    ip: ip || stored.ip || replicaAddress,
    address: replicaAddress,
    serviceName: serviceName || stored.serviceName || replicaAddress,
    lastSeen: new Date().toISOString(),
  };
  replicaRegistry.set(key, updated);
  return updated;
};

const listReplicas = () => Array.from(replicaRegistry.values())
  .sort((a, b) => a.pod.localeCompare(b.pod));

const pruneReplicas = () => {
  const threshold = Date.now() - REPLICA_TTL_MS;
  let removed = 0;
  replicaRegistry.forEach((replica, key) => {
    if (new Date(replica.lastSeen).getTime() < threshold) {
      replicaRegistry.delete(key);
      removed += 1;
    }
  });

  if (removed > 0) {
    log.info(`Pruned ${removed} stale replica entries`);
  }
};

const discoverPeers = async () => {
  try {
    const addresses = await dns.resolve4(peerServiceFQDN);
    addresses.forEach((ip) => {
      upsertReplica({
        pod: ip,
        ip,
        address: ip,
        serviceName: `${PEER_SERVICE_NAME}.${NAMESPACE}.${SERVICE_DNS_SUFFIX}`,
      });
    });
    log.debug('Discovered peers:', listReplicas());
  } catch (error) {
    if (error.code !== 'ENODATA' && error.code !== 'ENOTFOUND') {
      log.warn('Peer discovery failed:', error.message);
    }
  }
};

setInterval(() => {
  discoverPeers();
  pruneReplicas();
}, DISCOVERY_INTERVAL_MS).unref();

discoverPeers();

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    pod: POD_NAME, 
    ip: POD_IP,
    timestamp: new Date().toISOString()
  });
});

const getReplicaResponse = () => ({
  current: {
    pod: POD_NAME,
    ip: POD_IP,
    namespace: NAMESPACE,
    serviceName: PEER_SERVICE_NAME,
    role: SERVICE_ROLE,
    environment: ENVIRONMENT,
    discoveredAt: new Date().toISOString(),
  },
  knownReplicas: listReplicas(),
  totalMessages: messages.length,
});

// Get replica information
app.get('/replicas', (req, res) => {
  pruneReplicas();
  res.json(getReplicaResponse());
});

// Simple role indicator
app.get('/info', (req, res) => {
  res.json({
    pod: POD_NAME,
    role: SERVICE_ROLE,
    environment: ENVIRONMENT,
  });
});

const sendNotification = async ({ content, from }) => {
  if (!NOTIFICATION_TARGET_SERVICE) {
    log.warn('Notification target service is not configured');
    return;
  }

  try {
    await axios.post(`http://${NOTIFICATION_TARGET_SERVICE}:${PEER_SERVICE_PORT}/notifications/receive`, {
      content,
      from,
    }, { timeout: BROADCAST_TIMEOUT });
    log.info(`Notification sent to ${NOTIFICATION_TARGET_SERVICE}`);
  } catch (error) {
    log.warn(`Failed to send notification: ${error.message}`);
  }
};

// Send message to other replicas
app.post('/message', async (req, res) => {
  const { content, targetReplica } = req.body;
  
  if (!content) {
    return res.status(400).json({ error: 'Message content is required' });
  }

  const message = {
    id: Date.now().toString(),
    content,
    from: POD_NAME,
    timestamp: new Date().toISOString(),
    targetReplica
  };

  // Add to local messages
  messages.push(message);
  trimMessages();

  // If targetReplica is specified, try to send directly to that replica
  if (targetReplica && targetReplica !== POD_NAME) {
    const target = listReplicas().find((replica) => replica.pod === targetReplica || replica.id === targetReplica);
    if (target) {
      try {
        await axios.post(`http://${target.serviceName}:${PEER_SERVICE_PORT}/message/receive`, {
          content: `[Forwarded from ${POD_NAME}] ${content}`,
          from: POD_NAME,
        }, { timeout: BROADCAST_TIMEOUT });
        log.info(`Forwarded message to ${targetReplica}`);
      } catch (error) {
        log.warn(`Failed to forward message to ${targetReplica}:`, error.message);
      }
    }
  }

  res.json({ 
    success: true, 
    messageId: message.id,
    pod: POD_NAME 
  });
  log.info(`Message sent to ${targetReplica}: ${content}`);
});

// Receive message from other replicas
app.post('/message/receive', async (req, res) => {
  const { content, from } = req.body;
  
  if (!content) {
    return res.status(400).json({ error: 'Message content is required' });
  }

  const message = {
    id: Date.now().toString(),
    content,
    from: from || 'unknown',
    timestamp: new Date().toISOString()
  };

  if (SERVICE_ROLE === 'message') {
    messages.push(message);
    await sendNotification({ content, from: from || POD_NAME });
  } else {
    notifications.push(message);
  }
  trimMessages();
  log.info(`Received message from ${from}: ${content}`);

  res.json({ success: true, messageId: message.id });
});

// Get all messages
app.get('/messages', (req, res) => {
  if (SERVICE_ROLE !== 'message') {
    return res.status(400).json({
      error: 'This service role does not track messages'
    });
  }
  res.json({
    pod: POD_NAME,
    messages: messages,
    count: messages.length
  });
});

app.get('/notifications', (req, res) => {
  if (SERVICE_ROLE !== 'notification') {
    return res.status(400).json({
      error: 'This service role does not track notifications'
    });
  }
  res.json({
    pod: POD_NAME,
    notifications,
    count: notifications.length,
  });
});

app.post('/notifications/receive', (req, res) => {
  if (SERVICE_ROLE !== 'notification') {
    return res.status(400).json({ error: 'Only notification service can receive notifications' });
  }

  const { content, from } = req.body;
  if (!content) {
    return res.status(400).json({ error: 'Notification content is required' });
  }

  const notification = {
    id: Date.now().toString(),
    content,
    from: from || 'unknown',
    timestamp: new Date().toISOString(),
  };

  notifications.push(notification);
  trimMessages();
  log.info(`Notification received from ${from}: ${content}`);

  res.json({ success: true, notificationId: notification.id });
});

// Broadcast to all known replicas
app.post('/broadcast', async (req, res) => {
  const { content } = req.body;
  
  if (!content) {
    return res.status(400).json({ error: 'Message content is required' });
  }

  const message = {
    id: Date.now().toString(),
    content,
    from: POD_NAME,
    timestamp: new Date().toISOString(),
    type: 'broadcast'
  };

  if (SERVICE_ROLE === 'message') {
    messages.push(message);
    trimMessages();
    await sendNotification({ content, from: POD_NAME });
  } else {
    notifications.push(message);
    trimMessages();
  }

  // Broadcast to all other known replicas
  const broadcastPromises = listReplicas()
    .filter(replica => replica.pod !== POD_NAME)
    .map(async (replica) => {
      try {
        await axios.post(`http://${replica.serviceName}:${PEER_SERVICE_PORT}/message/receive`, {
          content: `[Broadcast from ${POD_NAME}] ${content}`,
          from: POD_NAME
        }, { timeout: BROADCAST_TIMEOUT });
        log.info(`Broadcast sent to ${replica.pod}`);
      } catch (error) {
        log.warn(`Failed to broadcast to ${replica.pod}:`, error.message);
      }
    });

  await Promise.allSettled(broadcastPromises);

  res.json({ 
    success: true, 
    messageId: message.id,
    broadcasted: true,
    pod: POD_NAME 
  });
});

// Discover other replicas (manual registration)
app.post('/discover', (req, res) => {
  const { pod, ip, address, serviceName } = req.body;
  const replica = upsertReplica({ pod, ip, address, serviceName });
  res.json({ success: true, registered: replica, knownReplicas: listReplicas().length });
});

// Clear messages (for testing)
app.delete('/messages', (req, res) => {
  if (SERVICE_ROLE !== 'message') {
    return res.status(400).json({ error: 'Only message service can clear messages' });
  }
  messages = [];
  res.json({ success: true, message: 'Messages cleared' });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Node.js Kubernetes App',
    pod: POD_NAME,
    ip: POD_IP,
    namespace: NAMESPACE,
    role: SERVICE_ROLE,
    environment: ENVIRONMENT,
    endpoints: {
      health: '/health',
      replicas: '/replicas',
      messages: '/messages',
      sendMessage: 'POST /message',
      broadcast: 'POST /broadcast',
      discover: 'POST /discover'
    },
    roleSpecific: SERVICE_ROLE === 'notification' ? {
      notifications: '/notifications',
      receiveNotification: 'POST /notifications/receive'
    } : {
      messages: '/messages',
      broadcast: 'POST /broadcast'
    }
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Pod: ${POD_NAME}`);
  console.log(`IP: ${POD_IP}`);
  console.log(`Namespace: ${NAMESPACE}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully');
  process.exit(0);
});
