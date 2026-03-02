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

// Delete a student
app.delete('/api/students/:id', async (req, res) => {
  try {
    await Student.findByIdAndDelete(req.params.id);
    // Also remove from sessions
    await Session.updateMany({ student: req.params.id }, { $unset: { student: 1 } });
    res.json({ success: true });
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

// Delete a tutor
app.delete('/api/tutors/:id', async (req, res) => {
  try {
    await Tutor.findByIdAndDelete(req.params.id);
    // Unassign from students
    await Student.updateMany({ assignedTutor: req.params.id }, { $unset: { assignedTutor: 1 } });
    res.json({ success: true });
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

// Delete a session
app.delete('/api/sessions/:id', async (req, res) => {
  try {
    await Session.findByIdAndDelete(req.params.id);
    res.json({ success: true });
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

// Get a single student by ID
app.get('/api/students/:id', async (req, res) => {
  try {
    const student = await Student.findById(req.params.id).populate('assignedTutor');
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }
    res.json(student);
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

// Get a single tutor by ID
app.get('/api/tutors/:id', async (req, res) => {
  try {
    const tutor = await Tutor.findById(req.params.id);
    if (!tutor) {
      return res.status(404).json({ error: 'Tutor not found' });
    }
    res.json(tutor);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all sessions (for admin)
app.get('/api/sessions/all', async (req, res) => {
  try {
    const sessions = await Session.find({ date: { $gte: new Date() } })
      .populate('student')
      .populate('tutor')
      .sort({ date: 1 });
    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Manual trigger for testing
app.post('/api/trigger-sessions', async (req, res) => {
  try {
    console.log('🔄 Manually triggering session creation...');
    
    const students = await Student.find({ assignedTutor: { $ne: null } }).populate('assignedTutor');
    let createdCount = 0;
    
    for (const student of students) {
      const tutor = student.assignedTutor;
      
      for (let i = 0; i < 7; i++) {
        const date = moment().tz('Asia/Karachi').add(i, 'days');
        const dayName = date.format('dddd');
        
        const worksToday = tutor.availability?.some(a => a.day === dayName);
        
        if (worksToday) {
          const exists = await Session.findOne({
            student: student._id,
            date: {
              $gte: date.startOf('day').toDate(),
              $lte: date.endOf('day').toDate()
            }
          });
          
          if (!exists) {
            const meeting = await zoomService.createMeeting(
              `Quran Session - ${student.name}`,
              date.format('YYYY-MM-DD') + 'T17:00:00'
            );
            
            if (meeting) {
              const session = new Session({
                student: student._id,
                tutor: tutor._id,
                date: date.toDate(),
                time: '17:00',
                zoomLink: meeting.join_url,
                zoomMeetingId: meeting.id
              });
              
              await session.save();
              createdCount++;
            }
          }
        }
      }
    }
    
    res.json({ success: true, message: `Created ${createdCount} sessions` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ADMIN DASHBOARD ====================
app.get('/admin', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Tutor Connect Admin</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { 
            font-family: 'Segoe UI', Arial, sans-serif; 
            background: #f0f2f5; 
            padding: 20px;
        }
        .container { max-width: 1400px; margin: auto; }
        h1 { color: #1a5f7a; margin-bottom: 30px; display: flex; align-items: center; gap: 10px; }
        h1 span { background: #1a5f7a; color: white; padding: 5px 15px; border-radius: 20px; font-size: 16px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .card { 
            background: white; 
            padding: 25px; 
            border-radius: 15px; 
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            transition: transform 0.2s;
        }
        .card:hover { transform: translateY(-2px); }
        h2 { color: #2c3e50; margin-bottom: 20px; font-size: 20px; display: flex; align-items: center; gap: 10px; }
        .form-group { margin-bottom: 15px; }
        label { display: block; margin-bottom: 5px; color: #4a5568; font-weight: 500; }
        input, select { 
            width: 100%; 
            padding: 12px; 
            border: 2px solid #e2e8f0; 
            border-radius: 8px; 
            font-size: 14px;
            transition: border-color 0.2s;
        }
        input:focus, select:focus { outline: none; border-color: #1a5f7a; }
        button { 
            background: #1a5f7a; 
            color: white; 
            border: none; 
            padding: 12px 25px; 
            border-radius: 8px; 
            cursor: pointer; 
            font-size: 16px;
            font-weight: 600;
            transition: background 0.2s;
            width: 100%;
        }
        button:hover { background: #0f4a61; }
        button.secondary { background: #2d3748; }
        button.secondary:hover { background: #1a202c; }
        button.success { background: #38a169; }
        button.success:hover { background: #2f855a; }
        button.delete { background: #e53e3e; padding: 5px 10px; width: auto; font-size: 12px; }
        button.delete:hover { background: #c53030; }
        .checkbox-group { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(80px, 1fr)); 
            gap: 10px; 
            margin: 10px 0;
        }
        .checkbox-group label { 
            display: flex; 
            align-items: center; 
            gap: 5px; 
            font-weight: normal;
        }
        table { 
            width: 100%; 
            border-collapse: collapse; 
            background: white; 
            border-radius: 10px; 
            overflow: hidden;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        th { 
            background: #1a5f7a; 
            color: white; 
            padding: 15px; 
            text-align: left;
        }
        td { 
            padding: 12px 15px; 
            border-bottom: 1px solid #e2e8f0;
        }
        tr:hover { background: #f7fafc; }
        .stats {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 15px;
            margin-bottom: 20px;
        }
        .stat-card {
            background: white;
            padding: 20px;
            border-radius: 10px;
            text-align: center;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .stat-number {
            font-size: 32px;
            font-weight: bold;
            color: #1a5f7a;
        }
        .stat-label {
            color: #4a5568;
            font-size: 14px;
        }
        .message {
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 15px 25px;
            border-radius: 8px;
            color: white;
            display: none;
            z-index: 1000;
        }
        .message.success { background: #38a169; }
        .message.error { background: #e53e3e; }
        .action-cell { display: flex; gap: 5px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>
            📚 Tutor Connect Admin 
            <span id="liveStatus">Live</span>
        </h1>
        
        <div class="stats">
            <div class="stat-card">
                <div class="stat-number" id="totalStudents">0</div>
                <div class="stat-label">Students</div>
            </div>
            <div class="stat-card">
                <div class="stat-number" id="totalTutors">0</div>
                <div class="stat-label">Tutors</div>
            </div>
            <div class="stat-card">
                <div class="stat-number" id="todaySessions">0</div>
                <div class="stat-label">Today's Sessions</div>
            </div>
        </div>
        
        <div class="grid">
            <!-- Add Student Card -->
            <div class="card">
                <h2>➕ Add Student</h2>
                <div class="form-group">
                    <label>Student Name</label>
                    <input type="text" id="studentName" placeholder="e.g., Ali Ahmed">
                </div>
                <div class="form-group">
                    <label>Parent Name</label>
                    <input type="text" id="parentName" placeholder="e.g., Mr. Khan">
                </div>
                <div class="form-group">
                    <label>Parent WhatsApp (with country code)</label>
                    <input type="text" id="parentPhone" placeholder="e.g., 923001234567">
                </div>
                <div class="form-group">
                    <label>Age</label>
                    <input type="number" id="age" placeholder="e.g., 10">
                </div>
                <div class="form-group">
                    <label>Level</label>
                    <select id="level">
                        <option value="Beginner">Beginner</option>
                        <option value="Intermediate">Intermediate</option>
                        <option value="Advanced">Advanced</option>
                    </select>
                </div>
                <button onclick="addStudent()">Add Student</button>
            </div>
            
            <!-- Add Tutor Card -->
            <div class="card">
                <h2>👨‍🏫 Add Tutor</h2>
                <div class="form-group">
                    <label>Tutor Name</label>
                    <input type="text" id="tutorName" placeholder="e.g., Qari Ahmed">
                </div>
                <div class="form-group">
                    <label>WhatsApp Number</label>
                    <input type="text" id="tutorPhone" placeholder="e.g., 923001234567">
                </div>
                <div class="form-group">
                    <label>Email</label>
                    <input type="email" id="tutorEmail" placeholder="ahmed@example.com">
                </div>
                <div class="form-group">
                    <label>Availability</label>
                    <div class="checkbox-group">
                        <label><input type="checkbox" value="Monday"> Mon</label>
                        <label><input type="checkbox" value="Tuesday"> Tue</label>
                        <label><input type="checkbox" value="Wednesday"> Wed</label>
                        <label><input type="checkbox" value="Thursday"> Thu</label>
                        <label><input type="checkbox" value="Friday"> Fri</label>
                        <label><input type="checkbox" value="Saturday"> Sat</label>
                    </div>
                </div>
                <button onclick="addTutor()">Add Tutor</button>
            </div>
            
            <!-- Assign & Trigger Card -->
            <div class="card">
                <h2>📋 Assign Tutor</h2>
                <div class="form-group">
                    <label>Select Student</label>
                    <select id="assignStudent"></select>
                </div>
                <div class="form-group">
                    <label>Select Tutor</label>
                    <select id="assignTutor"></select>
                </div>
                <button onclick="assignTutor()" class="secondary">Assign</button>
                
                <hr style="margin: 20px 0;">
                
                <h2>🎯 Manual Trigger</h2>
                <button onclick="triggerSessions()" class="success">Create Sessions Now</button>
            </div>
        </div>
        
        <!-- Students Table -->
        <div class="card" style="margin-top: 20px;">
            <h2>📋 Students List</h2>
            <table>
                <thead>
                    <tr><th>Name</th><th>Parent</th><th>Phone</th><th>Level</th><th>Tutor</th><th>Action</th></tr>
                </thead>
                <tbody id="studentsTable"></tbody>
            </table>
        </div>
        
        <!-- Tutors Table -->
        <div class="card" style="margin-top: 20px;">
            <h2>👨‍🏫 Tutors List</h2>
            <table>
                <thead>
                    <tr><th>Name</th><th>Phone</th><th>Email</th><th>Availability</th><th>Action</th></tr>
                </thead>
                <tbody id="tutorsTable"></tbody>
            </table>
        </div>
        
        <!-- Sessions Table -->
        <div class="card" style="margin-top: 20px;">
            <h2>📅 Upcoming Sessions</h2>
            <table>
                <thead>
                    <tr><th>Student</th><th>Tutor</th><th>Date</th><th>Time</th><th>Link</th><th>Action</th></tr>
                </thead>
                <tbody id="sessionsTable"></tbody>
            </table>
        </div>
    </div>
    
    <div id="message" class="message"></div>
    
    <script>
        const API = window.location.origin;
        
        function showMessage(text, type = 'success') {
            const msg = document.getElementById('message');
            msg.textContent = text;
            msg.className = 'message ' + type;
            msg.style.display = 'block';
            setTimeout(() => msg.style.display = 'none', 3000);
        }
        
        async function deleteStudent(id) {
            if (!confirm('⚠️ Are you sure you want to delete this student? This will also remove them from sessions.')) return;
            
            try {
                const res = await fetch(API + '/api/students/' + id, {
                    method: 'DELETE'
                });
                const data = await res.json();
                if (data.success) {
                    showMessage('Student deleted successfully!');
                    loadData();
                }
            } catch (error) {
                showMessage('Error deleting student', 'error');
            }
        }
        
        async function deleteTutor(id) {
            if (!confirm('⚠️ Are you sure you want to delete this tutor? This will unassign them from all students.')) return;
            
            try {
                const res = await fetch(API + '/api/tutors/' + id, {
                    method: 'DELETE'
                });
                const data = await res.json();
                if (data.success) {
                    showMessage('Tutor deleted successfully!');
                    loadData();
                }
            } catch (error) {
                showMessage('Error deleting tutor', 'error');
            }
        }
        
        async function deleteSession(id) {
            if (!confirm('⚠️ Are you sure you want to delete this session?')) return;
            
            try {
                const res = await fetch(API + '/api/sessions/' + id, {
                    method: 'DELETE'
                });
                const data = await res.json();
                if (data.success) {
                    showMessage('Session deleted successfully!');
                    loadData();
                }
            } catch (error) {
                showMessage('Error deleting session', 'error');
            }
        }
        
        async function loadData() {
            try {
                // Load students
                const studentsRes = await fetch(API + '/api/students');
                const students = await studentsRes.json();
                
                let studentHtml = '';
                let studentOptions = '';
                students.forEach(s => {
                    studentHtml += \`<tr>
                        <td>\${s.name}</td>
                        <td>\${s.parentName}</td>
                        <td>\${s.parentPhone}</td>
                        <td>\${s.level}</td>
                        <td>\${s.assignedTutor?.name || 'Not assigned'}</td>
                        <td><button class="delete" onclick="deleteStudent('\${s._id}')">Delete</button></td>
                    </tr>\`;
                    studentOptions += \`<option value="\${s._id}">\${s.name} (\${s.parentPhone})</option>\`;
                });
                document.getElementById('studentsTable').innerHTML = studentHtml;
                document.getElementById('assignStudent').innerHTML = studentOptions;
                document.getElementById('totalStudents').textContent = students.length;
                
                // Load tutors
                const tutorsRes = await fetch(API + '/api/tutors');
                const tutors = await tutorsRes.json();
                
                let tutorHtml = '';
                let tutorOptions = '';
                tutors.forEach(t => {
                    tutorHtml += \`<tr>
                        <td>\${t.name}</td>
                        <td>\${t.phone}</td>
                        <td>\${t.email}</td>
                        <td>\${t.availability.map(a => a.day).join(', ')}</td>
                        <td><button class="delete" onclick="deleteTutor('\${t._id}')">Delete</button></td>
                    </tr>\`;
                    tutorOptions += \`<option value="\${t._id}">\${t.name}</option>\`;
                });
                document.getElementById('tutorsTable').innerHTML = tutorHtml;
                document.getElementById('assignTutor').innerHTML = tutorOptions;
                document.getElementById('totalTutors').textContent = tutors.length;
                
                // Load sessions
                const sessionsRes = await fetch(API + '/api/sessions/all');
                if (sessionsRes.ok) {
                    const sessions = await sessionsRes.json();
                    
                    // Update today's sessions count
                    const today = new Date().toISOString().split('T')[0];
                    const todaySessions = sessions.filter(s => 
                        new Date(s.date).toISOString().split('T')[0] === today
                    );
                    document.getElementById('todaySessions').textContent = todaySessions.length;
                    
                    // Build sessions table
                    let sessionHtml = '';
                    sessions.forEach(s => {
                        sessionHtml += \`<tr>
                            <td>\${s.student?.name || 'Deleted'}</td>
                            <td>\${s.tutor?.name || 'Deleted'}</td>
                            <td>\${new Date(s.date).toLocaleDateString()}</td>
                            <td>\${s.time}</td>
                            <td><a href="\${s.zoomLink}" target="_blank">Link</a></td>
                            <td><button class="delete" onclick="deleteSession('\${s._id}')">Delete</button></td>
                        </tr>\`;
                    });
                    document.getElementById('sessionsTable').innerHTML = sessionHtml;
                }
            } catch (error) {
                console.error('Error loading data:', error);
            }
        }
        
        async function addStudent() {
            const student = {
                name: document.getElementById('studentName').value,
                parentName: document.getElementById('parentName').value,
                parentPhone: document.getElementById('parentPhone').value,
                age: document.getElementById('age').value,
                level: document.getElementById('level').value
            };
            
            try {
                const res = await fetch(API + '/api/students', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(student)
                });
                const data = await res.json();
                if (data.success) {
                    showMessage('Student added successfully!');
                    loadData();
                    // Clear form
                    document.getElementById('studentName').value = '';
                    document.getElementById('parentName').value = '';
                    document.getElementById('parentPhone').value = '';
                    document.getElementById('age').value = '';
                }
            } catch (error) {
                showMessage('Error adding student', 'error');
            }
        }
        
        async function addTutor() {
            const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const availability = [];
            days.forEach(day => {
                if (document.querySelector(\`input[value="\${day}"]\`).checked) {
                    availability.push({day, startTime: '09:00', endTime: '21:00'});
                }
            });
            
            const tutor = {
                name: document.getElementById('tutorName').value,
                phone: document.getElementById('tutorPhone').value,
                email: document.getElementById('tutorEmail').value,
                availability
            };
            
            try {
                const res = await fetch(API + '/api/tutors', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(tutor)
                });
                const data = await res.json();
                if (data.success) {
                    showMessage('Tutor added successfully!');
                    loadData();
                    // Clear form
                    document.getElementById('tutorName').value = '';
                    document.getElementById('tutorPhone').value = '';
                    document.getElementById('tutorEmail').value = '';
                    document.querySelectorAll('input[type=checkbox]').forEach(c => c.checked = false);
                }
            } catch (error) {
                showMessage('Error adding tutor', 'error');
            }
        }
        
        async function assignTutor() {
            const studentId = document.getElementById('assignStudent').value;
            const tutorId = document.getElementById('assignTutor').value;
            
            try {
                const res = await fetch(API + '/api/assign', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({studentId, tutorId})
                });
                const data = await res.json();
                if (data.success) {
                    showMessage('Tutor assigned successfully!');
                    loadData();
                }
            } catch (error) {
                showMessage('Error assigning tutor', 'error');
            }
        }
        
        async function triggerSessions() {
            if (!confirm('Create sessions for next 7 days?')) return;
            
            try {
                const res = await fetch(API + '/api/trigger-sessions', {
                    method: 'POST'
                });
                const data = await res.json();
                showMessage(data.message || 'Sessions created!');
                loadData();
            } catch (error) {
                showMessage('Error creating sessions', 'error');
            }
        }
        
        // Load data every 30 seconds
        loadData();
        setInterval(loadData, 30000);
    </script>
</body>
</html>
  `);
});

// ==================== START SERVER ====================
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 Tutor Connect server running on port ${PORT}`);
  console.log(`📅 Scheduler: Runs daily at 12 AM`);
  console.log(`📱 WhatsApp: Ready`);
  console.log(`🎥 Zoom: Ready`);
  console.log(`📊 Admin Dashboard: http://localhost:${PORT}/admin`);
});
