// server.js - Tutor Connect Automated System
const express = require('express');
const mongoose = require('mongoose');
const cron = require('node-cron');
const moment = require('moment-timezone');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// ==================== CONNECT TO MONGODB ====================
console.log('Connecting to MongoDB...');
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// ==================== DATABASE MODELS ====================
const StudentSchema = new mongoose.Schema({
  name: String,
  parentName: String,
  parentPhone: String,
  age: Number,
  level: String,
  assignedTutor: { type: mongoose.Schema.Types.ObjectId, ref: 'Tutor' }
});

const TutorSchema = new mongoose.Schema({
  name: String,
  phone: String,
  email: String,
  availability: [{
    day: String, // Monday, Tuesday, etc.
    startTime: String,
    endTime: String
  }]
});

const SessionSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student' },
  tutor: { type: mongoose.Schema.Types.ObjectId, ref: 'Tutor' },
  date: Date,
  time: String,
  zoomLink: String,
  zoomMeetingId: String,
  status: { type: String, default: 'scheduled' }
});

const Student = mongoose.model('Student', StudentSchema);
const Tutor = mongoose.model('Tutor', TutorSchema);
const Session = mongoose.model('Session', SessionSchema);

// ==================== ZOOM SERVICE ====================
class ZoomService {
  async getToken() {
    const auth = Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString('base64');
    
    try {
      const response = await axios.post(
        `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${process.env.ZOOM_ACCOUNT_ID}`,
        {},
        {
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );
      
      return response.data.access_token;
    } catch (error) {
      console.error('❌ Zoom token error:', error.response?.data || error.message);
      return null;
    }
  }

  async createMeeting(topic, startTime) {
    try {
      const token = await this.getToken();
      if (!token) return null;

      const response = await axios.post(
        'https://api.zoom.us/v2/users/me/meetings',
        {
          topic: topic,
          type: 2,
          start_time: startTime,
          duration: 60,
          timezone: 'Asia/Karachi',
          settings: {
            join_before_host: false,
            waiting_room: false
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      return response.data;
    } catch (error) {
      console.error('❌ Zoom meeting error:', error.response?.data || error.message);
      return null;
    }
  }
}

// ==================== WHATSAPP SERVICE ====================
class WhatsAppService {
  async sendMessage(to, message) {
    try {
      const response = await axios.post(
        `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          to: to,
          type: 'text',
          text: { body: message }
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log(`✅ WhatsApp sent to ${to}`);
      return response.data;
    } catch (error) {
      console.error('❌ WhatsApp error:', error.response?.data || error.message);
      return null;
    }
  }

  async sendSessionLink(to, studentName, date, time, link) {
    const message = 
      `*Tutor Connect* 📚\n\n` +
      `Your Quran session is confirmed!\n\n` +
      `👤 Student: ${studentName}\n` +
      `📅 Date: ${date}\n` +
      `⏰ Time: ${time}\n\n` +
      `🔗 Join: ${link}\n\n` +
      `Please join 5 minutes early. JazakAllah Khair!`;
    
    return this.sendMessage(to, message);
  }
}

const zoomService = new ZoomService();
const whatsappService = new WhatsAppService();

// ==================== SCHEDULER ====================
// Run daily at 12 AM to create next week's sessions
cron.schedule('0 0 * * *', async () => {
  console.log('🔄 Running daily scheduler...');
  
  try {
    const students = await Student.find({ assignedTutor: { $ne: null } }).populate('assignedTutor');
    console.log(`Found ${students.length} students with tutors`);
    
    for (const student of students) {
      const tutor = student.assignedTutor;
      
      // Create sessions for next 7 days
      for (let i = 0; i < 7; i++) {
        const date = moment().tz('Asia/Karachi').add(i, 'days');
        const dayName = date.format('dddd');
        
        // Check if tutor works this day
        const worksToday = tutor.availability?.some(a => a.day === dayName);
        
        if (worksToday) {
          // Check if session already exists
          const exists = await Session.findOne({
            student: student._id,
            date: {
              $gte: date.startOf('day').toDate(),
              $lte: date.endOf('day').toDate()
            }
          });
          
          if (!exists) {
            console.log(`Creating session for ${student.name} on ${date.format('YYYY-MM-DD')}`);
            
            // Create Zoom meeting
            const meeting = await zoomService.createMeeting(
              `Quran Session - ${student.name}`,
              date.format('YYYY-MM-DD') + 'T17:00:00'
            );
            
            if (meeting) {
              // Save session
              const session = new Session({
                student: student._id,
                tutor: tutor._id,
                date: date.toDate(),
                time: '17:00',
                zoomLink: meeting.join_url,
                zoomMeetingId: meeting.id
              });
              
              await session.save();
              
              // Send WhatsApp to parent
              await whatsappService.sendSessionLink(
                student.parentPhone,
                student.name,
                date.format('MMMM Do, YYYY'),
                '5:00 PM',
                meeting.join_url
              );
              
              // Send WhatsApp to tutor
              await whatsappService.sendMessage(
                tutor.phone,
                `*New Session* 🎯\n\nStudent: ${student.name}\nDate: ${date.format('MMMM Do, YYYY')}\nTime: 5:00 PM\nLink: ${meeting.join_url}`
              );
              
              console.log(`✅ Session created for ${student.name}`);
              
              // Wait 1 second between messages
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ Scheduler error:', error);
  }
});

// ==================== API ROUTES ====================
// Add a new student
app.post('/api/students', async (req, res) => {
  try {
    const student = new Student(req.body);
    await student.save();
    res.json({ success: true, student });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add a new tutor
app.post('/api/tutors', async (req, res) => {
  try {
    const tutor = new Tutor(req.body);
    await tutor.save();
    res.json({ success: true, tutor });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Assign tutor to student
app.post('/api/assign', async (req, res) => {
  try {
    const { studentId, tutorId } = req.body;
    await Student.findByIdAndUpdate(studentId, { assignedTutor: tutorId });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all sessions for a student
app.get('/api/sessions/:studentId', async (req, res) => {
  try {
    const sessions = await Session.find({ 
      student: req.params.studentId,
      date: { $gte: new Date() }
    }).populate('tutor');
    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all students
app.get('/api/students', async (req, res) => {
  try {
    const students = await Student.find().populate('assignedTutor');
    res.json(students);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all tutors
app.get('/api/tutors', async (req, res) => {
  try {
    const tutors = await Tutor.find();
    res.json(tutors);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== START SERVER ====================
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 Tutor Connect server running on port ${PORT}`);
  console.log(`📅 Scheduler: Runs daily at 12 AM`);
  console.log(`📱 WhatsApp: Ready`);
  console.log(`🎥 Zoom: Ready`);
});