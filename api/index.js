// ─── REQUIREMENTS ────────────────────────────────────────────────────
const express  = require("express");
const path     = require("path");
const cors     = require("cors");
const multer = require("multer");
const { SESv2Client, SendEmailCommand } = require("@aws-sdk/client-sesv2");
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectsCommand, CopyObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { simpleParser } = require("mailparser");


// ─── ENVIRONMENT & CONFIG ─────────────────────────────────────────────
// Vercel will provide these from Environment Variables
const {
  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
  SES_REGION = "us-east-1",
  S3_BUCKET, S3_REGION = "us-east-1",
  APP_USER, APP_PASSWORD,
  AUTH_TOKEN, // <-- ADDED HERE
} = process.env;

// Define S3 prefixes for folders
const INBOX_PREFIX = "";
const SENT_PREFIX = "sent/";
const TRASH_PREFIX = "trash/";

// ─── ALLOWED SENDERS ─────────────────────────────────────────────────
const ALLOWED_SENDERS = ["admin@oodac.com", "feedback-spinfinity@oodac.com"];

// ─── AWS CLIENTS & EXPRESS APP ───────────────────────────────────────
const credentials = { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY };
const sesClient = new SESv2Client({ region: SES_REGION, credentials });
const s3Client  = new S3Client({ region: S3_REGION, credentials });
const app  = express();
const upload = multer({ storage: multer.memoryStorage() });


// --- MIDDLEWARE & CORS ---
// Let Vercel handle CORS based on its own domain.
// The VERCEL_URL variable is automatically provided by the platform.
const allowedOrigin = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://127.0.0.1:5501';
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


// ─── AUTHENTICATION ──────────────────────────────────────────────────
app.post("/login", (req, res) => {
    const { username, password } = req.body;
    if (username === APP_USER && password === APP_PASSWORD) {
        res.json({ success: true, token: AUTH_TOKEN });
    } else {
        res.status(401).json({ success: false, message: "Invalid credentials" });
    }
});

const authenticate = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.substring(7, authHeader.length);
        if (token === AUTH_TOKEN) { // It will now compare against the token from the environment
            return next();
        }
    }
    return res.status(401).json({ message: "Unauthorized: Invalid or missing token" });
};

// ─── HELPERS ──────────────────────────────────────────────────────────
const streamToString = stream => new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", chunk => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
});

const getEmailsFromS3 = async (prefix) => {
    const listCmdParams = { Bucket: S3_BUCKET, Prefix: prefix };
    if (prefix === INBOX_PREFIX) {
        listCmdParams.Delimiter = '/';
    }
    const listCmd = new ListObjectsV2Command(listCmdParams);
    const listRes = await s3Client.send(listCmd);
    
    const objects = (listRes.Contents || [])
      .filter(obj => obj.Key !== prefix && obj.Size > 0)
      .sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified))
      .slice(0, 100); 
    
    const totalCount = objects.length;

    const emails = await Promise.all(
      objects.map(async (obj) => {
        const getRes = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key }));
        const rawEmail = await streamToString(getRes.Body);
        const parsed = await simpleParser(rawEmail);
        
        let textSnippet = parsed.text || '';
        if (!textSnippet && parsed.html) {
            textSnippet = parsed.html.replace(/<style[^>]*>.*<\/style>/gms, '').replace(/<script[^>]*>.*<\/script>/gms, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        }

        const attachments = parsed.attachments || [];

        return {
          id: obj.Key, from: parsed.from?.text || "", to: parsed.to?.text || "",
          sender: parsed.headers.get('x-maildeck-sender') || parsed.from?.text || "", 
          subject: parsed.subject || "(no subject)", date: parsed.date || obj.LastModified,
          snippet: textSnippet.substring(0, 200),
          htmlBody: parsed.html || parsed.textAsHtml || "",
          hasAttachments: attachments.length > 0,
          attachments: attachments.map((a, index) => ({filename: a.filename, size: a.size, index}))
        };
      })
    );
    return { emails, totalCount };
};

// ─── PROTECTED API ROUTES ───────────────────────────────────────────
// ... All your other routes like app.post("/send-email", ...), etc. remain the same ...
app.post("/send-email", authenticate, upload.array('attachments'), async (req, res) => {
  const { from, to, cc, bcc, subject, html } = req.body;
  if (!from || !to || !subject || !html) return res.status(400).json({ message: "Missing required fields" });
  if (!ALLOWED_SENDERS.includes(from)) return res.status(403).json({ message: `Sending from ${from} is not permitted.` });
  
  try {
    let rawEmail = `From: ${from}\nTo: ${to}\n`;
    if (cc) rawEmail += `Cc: ${cc}\n`;
    rawEmail += `Subject: ${subject}\n`;
    rawEmail += `X-MailDeck-Sender: ${from}\n`;
    rawEmail += `MIME-Version: 1.0\n`;
    rawEmail += `Content-Type: multipart/mixed; boundary="boundary_12345"\n\n`;
    rawEmail += `--boundary_12345\n`;
    rawEmail += `Content-Type: text/html; charset=UTF-8\n\n`;
    rawEmail += `${html}\n\n`;
    
    const attachments = req.files ? req.files.map(file => ({
        filename: file.originalname, content: file.buffer, contentType: file.mimetype
    })) : [];

    attachments.forEach(att => {
        rawEmail += `--boundary_12345\n`;
        rawEmail += `Content-Type: ${att.contentType}; name="${att.filename}"\n`;
        rawEmail += `Content-Transfer-Encoding: base64\n`;
        rawEmail += `Content-Disposition: attachment; filename="${att.filename}"\n\n`;
        rawEmail += `${att.content.toString('base64')}\n\n`;
    });
    rawEmail += `--boundary_12345--`;

    const command = new SendEmailCommand({
        Content: { Raw: { Data: Buffer.from(rawEmail) } },
        Destination: { ToAddresses: to.split(','), CcAddresses: cc ? cc.split(',') : [], BccAddresses: bcc ? bcc.split(',') : [] },
        FromEmailAddress: from,
    });
    const info = await sesClient.send(command);

    const sentEmailKey = `${SENT_PREFIX}${info.MessageId}`;
    const s3SaveCommand = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: sentEmailKey,
      Body: rawEmail
    });
    await s3Client.send(s3SaveCommand);

    res.json({ message: "Email sent", messageId: info.MessageId });
  } catch (err) {
    console.error("SES send error:", err);
    res.status(500).json({ message: "Failed to send email", detail: err.message });
  }
});

app.get("/inbox", authenticate, async (_, res) => {
  try {
    res.json(await getEmailsFromS3(INBOX_PREFIX));
  } catch (err) {
    console.error("S3 inbox error:", err);
    res.status(500).json({ message: "Failed to load inbox", detail: err.message });
  }
});

app.get("/sent", authenticate, async (_, res) => {
    try {
        res.json(await getEmailsFromS3(SENT_PREFIX));
    } catch (err) {
        console.error("S3 sent error:", err);
        res.status(500).json({ message: "Failed to load sent items", detail: err.message });
    }
});

app.get("/trash", authenticate, async (_, res) => {
    try {
        res.json(await getEmailsFromS3(TRASH_PREFIX));
    } catch (err) {
        console.error("S3 trash error:", err);
        res.status(500).json({ message: "Failed to load trash", detail: err.message });
    }
});

app.post("/emails/move-to-trash", authenticate, async(req, res) => {
    const { emailIds } = req.body;
    if (!emailIds || !Array.isArray(emailIds) || emailIds.length === 0) {
        return res.status(400).json({ message: "No email IDs provided" });
    }
    try {
        for (const id of emailIds) {
            const newKey = `${TRASH_PREFIX}${path.basename(id)}`;
            const copyCommand = new CopyObjectCommand({
                Bucket: S3_BUCKET,
                CopySource: `${S3_BUCKET}/${id}`,
                Key: newKey
            });
            await s3Client.send(copyCommand);
            const deleteCommand = new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: id });
            await s3Client.send(deleteCommand);
        }
        res.json({ success: true, message: `Moved ${emailIds.length} email(s) to trash.` });
    } catch (err) {
        console.error("Move to trash error:", err);
        res.status(500).json({ message: "Failed to move emails to trash", detail: err.message });
    }
});

app.post("/emails/delete-permanently", authenticate, async(req, res) => {
    const { emailIds } = req.body;
    if (!emailIds || !Array.isArray(emailIds) || emailIds.length === 0) {
        return res.status(400).json({ message: "No email IDs provided" });
    }
    try {
        const deleteParams = {
            Bucket: S3_BUCKET,
            Delete: { Objects: emailIds.map(id => ({ Key: id })) }
        };
        await s3Client.send(new DeleteObjectsCommand(deleteParams));
        res.json({ success: true, message: `Permanently deleted ${emailIds.length} email(s).` });
    } catch (err) {
        console.error("Permanent delete error:", err);
        res.status(500).json({ message: "Failed to permanently delete emails", detail: err.message });
    }
});

app.get("/download-attachment", authenticate, async (req, res) => {
    const { emailId, index } = req.query;
    if (!emailId || index === undefined) return res.status(400).send("Missing email ID or attachment index.");
    try {
        const getRes = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: emailId }));
        const rawEmail = await streamToString(getRes.Body);
        const parsed = await simpleParser(rawEmail);
        const attachment = parsed.attachments[parseInt(index, 10)];
        if (!attachment) return res.status(404).send("Attachment not found at that index.");
        res.setHeader('Content-Disposition', `attachment; filename="${attachment.filename}"`);
        res.setHeader('Content-Type', attachment.contentType);
        res.send(attachment.content);
    } catch(err) {
        console.error("Attachment download error:", err);
        res.status(500).send("Could not download attachment.");
    }
});


// ─── Vercel Export ───────────────────────────────────────────────────
module.exports = app;