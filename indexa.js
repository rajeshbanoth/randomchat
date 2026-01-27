// server.js - Backend with Nodemailer
const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors({
  origin: 'http://localhost:3000', // Your React app URL
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configure Nodemailer transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
  tls: {
    rejectUnauthorized: false
  }
});

// Test SMTP connection
transporter.verify((error, success) => {
  if (error) {
    console.error('SMTP Connection Error:', error);
  } else {
    console.log('✅ SMTP Server is ready to send emails');
  }
});

// Generate unique ticket number
const generateTicketNumber = () => {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substr(2, 6).toUpperCase();
  return `OMG-${timestamp}-${random}`;
};

// Get estimated response time
const getEstimatedResponse = (priority) => {
  const responseTimes = {
    'low': '48 hours',
    'normal': '24 hours',
    'high': '12 hours',
    'urgent': '2 hours'
  };
  return responseTimes[priority] || '24 hours';
};

// Generate beautiful HTML email template
const generateUserEmailHTML = (data, ticketNumber, estimatedResponse) => {
  const priorityColors = {
    'low': '#10B981',
    'normal': '#3B82F6',
    'high': '#F59E0B',
    'urgent': '#EF4444'
  };

  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Omegle Pro Support - Ticket Confirmation</title>
    <style>
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
      
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
        line-height: 1.6;
        color: #374151;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        min-height: 100vh;
        padding: 20px;
      }
      
      .email-container {
        max-width: 600px;
        margin: 0 auto;
        background: white;
        border-radius: 16px;
        overflow: hidden;
        box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      }
      
      .header {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        padding: 40px;
        text-align: center;
        color: white;
      }
      
      .logo {
        font-size: 32px;
        font-weight: bold;
        margin-bottom: 10px;
        letter-spacing: -0.5px;
      }
      
      .subtitle {
        opacity: 0.9;
        font-size: 16px;
      }
      
      .content {
        padding: 40px;
      }
      
      .ticket-number {
        background: linear-gradient(135deg, #f6d365 0%, #fda085 100%);
        color: white;
        padding: 15px;
        border-radius: 10px;
        text-align: center;
        font-size: 24px;
        font-weight: bold;
        margin-bottom: 30px;
        letter-spacing: 2px;
      }
      
      .greeting {
        font-size: 18px;
        margin-bottom: 20px;
        color: #1F2937;
      }
      
      .priority-badge {
        display: inline-block;
        padding: 8px 20px;
        border-radius: 20px;
        font-weight: bold;
        font-size: 14px;
        margin: 10px 0;
        color: white;
        background: ${priorityColors[data.priority]};
      }
      
      .info-card {
        background: #F9FAFB;
        border-radius: 12px;
        padding: 25px;
        margin: 25px 0;
        border-left: 4px solid #667eea;
      }
      
      .info-row {
        margin-bottom: 12px;
        display: flex;
      }
      
      .info-label {
        font-weight: 600;
        color: #6B7280;
        min-width: 120px;
      }
      
      .info-value {
        color: #1F2937;
        flex: 1;
      }
      
      .message-box {
        background: #F3F4F6;
        padding: 20px;
        border-radius: 8px;
        margin: 25px 0;
        border: 1px solid #E5E7EB;
      }
      
      .response-time {
        background: linear-gradient(135deg, #10B981 0%, #34D399 100%);
        color: white;
        padding: 20px;
        border-radius: 12px;
        text-align: center;
        margin: 25px 0;
      }
      
      .steps {
        margin: 30px 0;
      }
      
      .step {
        display: flex;
        align-items: flex-start;
        margin-bottom: 20px;
      }
      
      .step-number {
        background: #667eea;
        color: white;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: bold;
        margin-right: 15px;
        flex-shrink: 0;
      }
      
      .step-content {
        flex: 1;
      }
      
      .footer {
        background: #1F2937;
        color: #9CA3AF;
        padding: 30px;
        text-align: center;
        font-size: 14px;
      }
      
      .contact-info {
        margin: 20px 0;
        display: flex;
        justify-content: center;
        gap: 30px;
      }
      
      .contact-item {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      
      .divider {
        height: 1px;
        background: #374151;
        margin: 20px 0;
      }
      
      @media (max-width: 600px) {
        .content {
          padding: 25px;
        }
        
        .header {
          padding: 30px 20px;
        }
        
        .info-row {
          flex-direction: column;
        }
        
        .contact-info {
          flex-direction: column;
          gap: 15px;
        }
      }
    </style>
  </head>
  <body>
    <div class="email-container">
      <div class="header">
        <div class="logo">Omegle Pro</div>
        <div class="subtitle">Support Center</div>
      </div>
      
      <div class="content">
        <div class="ticket-number">${ticketNumber}</div>
        
        <div class="greeting">
          Hello <strong>${data.name}</strong>,
        </div>
        
        <p>Thank you for reaching out to Omegle Pro Support. We've received your message and our team is already reviewing it.</p>
        
        <div class="priority-badge">
          ${data.priority.charAt(0).toUpperCase() + data.priority.slice(1)} Priority
        </div>
        
        <div class="info-card">
          <div class="info-row">
            <span class="info-label">Contact Reason:</span>
            <span class="info-value">${data.contactReason}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Subject:</span>
            <span class="info-value">${data.subject}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Submitted:</span>
            <span class="info-value">${new Date().toLocaleString()}</span>
          </div>
        </div>
        
        <div class="message-box">
          <h3 style="margin-bottom: 10px; color: #374151;">Your Message:</h3>
          <p style="white-space: pre-wrap; color: #4B5563;">${data.message}</p>
        </div>
        
        <div class="response-time">
          <h3 style="margin-bottom: 10px;">⏰ Estimated Response Time</h3>
          <p style="font-size: 20px; font-weight: bold;">${estimatedResponse}</p>
          <p style="font-size: 14px; opacity: 0.9;">Our team will respond within this timeframe</p>
        </div>
        
        <div class="steps">
          <h3 style="margin-bottom: 20px; color: #1F2937;">📋 What Happens Next?</h3>
          
          <div class="step">
            <div class="step-number">1</div>
            <div class="step-content">
              <strong>Ticket Assignment</strong>
              <p>Your request has been assigned to the appropriate support specialist</p>
            </div>
          </div>
          
          <div class="step">
            <div class="step-number">2</div>
            <div class="step-content">
              <strong>Review & Analysis</strong>
              <p>Our team is analyzing your inquiry to provide the best solution</p>
            </div>
          </div>
          
          <div class="step">
            <div class="step-number">3</div>
            <div class="step-content">
              <strong>Response Preparation</strong>
              <p>We're preparing a detailed response addressing all your concerns</p>
            </div>
          </div>
          
          <div class="step">
            <div class="step-number">4</div>
            <div class="step-content">
              <strong>Follow-up Communication</strong>
              <p>You'll receive our response directly to this email address</p>
            </div>
          </div>
        </div>
        
        <div style="background: #FEF3C7; padding: 20px; border-radius: 10px; margin: 30px 0;">
          <h4 style="color: #92400E; margin-bottom: 10px;">💡 Need Immediate Help?</h4>
          <p style="color: #92400E;">
            For urgent safety concerns or emergencies, please email us immediately at 
            <strong style="color: #DC2626;">emergency@omeglepro.com</strong>
          </p>
        </div>
        
        <p style="color: #6B7280; font-size: 14px;">
          <strong>Note:</strong> You can reply directly to this email to add more information to your ticket.
          All future correspondence will reference ticket number <strong>${ticketNumber}</strong>.
        </p>
      </div>
      
      <div class="footer">
        <div class="contact-info">
          <div class="contact-item">
            <span style="color: #60A5FA;">📧</span>
            <span>support@omeglepro.com</span>
          </div>
          <div class="contact-item">
            <span style="color: #10B981;">🕒</span>
            <span>24/7 Support Available</span>
          </div>
        </div>
        
        <div class="divider"></div>
        
        <p>This is an automated confirmation email. Please do not reply to this message.</p>
        <p style="margin-top: 10px;">© 2026 Omegle Pro Technologies Pvt. Ltd. All rights reserved.</p>
        <p style="font-size: 12px; margin-top: 10px; opacity: 0.8;">
          123 Tech Park, Koramangala, Bangalore, Karnataka 560034, India
        </p>
      </div>
    </div>
  </body>
  </html>
  `;
};

// Generate support team notification email
const generateSupportEmailHTML = (data, ticketNumber) => {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <style>
      body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
      .container { max-width: 800px; margin: 0 auto; padding: 20px; }
      .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px 10px 0 0; }
      .content { background: #f8fafc; padding: 30px; border-radius: 0 0 10px 10px; }
      .ticket { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #667eea; }
      .label { font-weight: bold; color: #6b7280; min-width: 150px; display: inline-block; }
      .priority { display: inline-block; padding: 5px 15px; border-radius: 20px; color: white; font-weight: bold; }
      .priority-low { background: #10b981; }
      .priority-normal { background: #3b82f6; }
      .priority-high { background: #f59e0b; }
      .priority-urgent { background: #ef4444; }
      .message-box { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #e5e7eb; }
      .action-btn { display: inline-block; background: #667eea; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin: 10px 5px; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>📬 New Support Ticket</h1>
        <h2>${ticketNumber}</h2>
      </div>
      
      <div class="content">
        <div class="ticket">
          <h3>Ticket Information</h3>
          <p><span class="label">From:</span> ${data.name} &lt;${data.email}&gt;</p>
          <p><span class="label">Priority:</span> 
            <span class="priority priority-${data.priority}">${data.priority.toUpperCase()}</span>
          </p>
          <p><span class="label">Contact Reason:</span> ${data.contactReason}</p>
          <p><span class="label">Subject:</span> ${data.subject}</p>
          <p><span class="label">Submitted:</span> ${new Date().toLocaleString()}</p>
          <p><span class="label">IP Address:</span> ${data.ip || 'Not available'}</p>
        </div>
        
        <div class="message-box">
          <h3>User's Message:</h3>
          <p style="white-space: pre-wrap;">${data.message}</p>
        </div>
        
        <h3>Quick Actions:</h3>
        <a href="mailto:${data.email}" class="action-btn">✉️ Reply to User</a>
        <a href="#" class="action-btn">📊 View Full Details</a>
        <a href="#" class="action-btn">🚨 Mark as Urgent</a>
        
        <div style="margin-top: 30px; padding: 20px; background: #fef3c7; border-radius: 8px;">
          <h4>⚠️ IMPORTANT:</h4>
          <p>Please respond within the SLA timeframe based on priority:</p>
          <ul>
            <li><strong>Low:</strong> 48 hours</li>
            <li><strong>Normal:</strong> 24 hours</li>
            <li><strong>High:</strong> 12 hours</li>
            <li><strong>Urgent:</strong> 2 hours</li>
          </ul>
        </div>
      </div>
    </div>
  </body>
  </html>
  `;
};

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Contact form submission endpoint
app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, contactReason, subject, message, priority } = req.body;
    
    // Validation
    if (!name || !email || !contactReason || !subject || !message || !priority) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required'
      });
    }

    if (!/\S+@\S+\.\S+/.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid email address'
      });
    }

    if (message.length < 20) {
      return res.status(400).json({
        success: false,
        message: 'Message must be at least 20 characters long'
      });
    }

    const ticketNumber = generateTicketNumber();
    const estimatedResponse = getEstimatedResponse(priority);
    const userIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // Send confirmation email to user
    const userMailOptions = {
      from: `"Omegle Pro Support" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `We've received your message - ${ticketNumber}`,
      html: generateUserEmailHTML(req.body, ticketNumber, estimatedResponse)
    };

    // Send notification to support team
    const supportMailOptions = {
      from: `"Contact Form" <${process.env.SMTP_USER}>`,
      to: process.env.SUPPORT_EMAIL || process.env.SMTP_USER,
      subject: `New Support Ticket: ${ticketNumber} - ${subject}`,
      html: generateSupportEmailHTML({ ...req.body, ip: userIP }, ticketNumber)
    };

    // Send both emails
    await transporter.sendMail(userMailOptions);
    await transporter.sendMail(supportMailOptions);

    // Log to console for debugging
    console.log('📧 Email sent successfully:', {
      ticketNumber,
      to: email,
      priority,
      estimatedResponse
    });

    res.json({
      success: true,
      message: 'Message sent successfully!',
      data: {
        ticketNumber,
        estimatedResponse,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Email sending error:', error);
    
    // Detailed error logging
    if (error.code === 'EAUTH') {
      console.error('SMTP Authentication failed. Check your credentials.');
    } else if (error.code === 'ECONNECTION') {
      console.error('SMTP Connection failed. Check network/host/port.');
    } else if (error.code === 'EENVELOPE') {
      console.error('Invalid recipient address.');
    }

    res.status(500).json({
      success: false,
      message: 'Failed to send message. Please try again later.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get contact statistics
app.get('/api/contact/stats', (req, res) => {
  res.json({
    success: true,
    data: {
      averageResponseTime: '2.4 hours',
      satisfactionRate: '96.7%',
      ticketsResolved: '98.2%',
      supportStaffOnline: '24/7',
      monthlyVolume: '12,847 tickets'
    }
  });
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📧 SMTP User: ${process.env.SMTP_USER}`);
  console.log(`🌐 Health Check: http://localhost:${PORT}/api/health`);
});