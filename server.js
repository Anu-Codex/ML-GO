require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

mongoose.connect(process.env.MONGO_URI).then(() => console.log("✅ Connected to MongoDB"));

// --- SCHEMAS ---
const playerSchema = new mongoose.Schema({
    name: String, strength: Number, cardType: String, baseValue: Number,
    status: { type: String, default: 'Available' }, soldTo: { type: String, default: '-' }
});
const teamSchema = new mongoose.Schema({ name: String, budget: Number });
const chatSchema = new mongoose.Schema({ sender: String, role: String, text: String, timestamp: { type: Date, default: Date.now } });

const Player = mongoose.model('Player', playerSchema);
const Team = mongoose.model('Team', teamSchema);
const Chat = mongoose.model('Chat', chatSchema);

// --- AUTOMATIC TEAM SEEDING ---
async function seedTeams() {
    const teams = [
        { name: "Virat FC", budget: 100 },
        { name: "Neimesis eSports", budget: 100 },
        { name: "Team ICONIC", budget: 100 },
        { name: "Bluster FC", budget: 100 },
        { name: "Let it go na", budget: 100 },
        { name: "Skystrikers United", budget: 100 },
        { name: "ELITE MSN", budget: 100 },
        { name: "Visca", budget: 100 },
        { name: "MI CHAMPSS", budget: 100 },
        { name: "PREDETORS TRIO", budget: 100 }
    ];

    for (let t of teams) {
        const exists = await Team.findOne({ name: t.name });
        if (!exists) {
            await new Team(t).save();
            console.log(`🌱 Seeded team: ${t.name}`);
        }
    }
}
seedTeams();

// --- HTTP ROUTES ---

// Fixed the syntax error here. We only insert Name and Budget into the DB.
app.get('/reset-teams', async (req, res) => {
    try {
        await Team.deleteMany({}); 
        const teamData = [
            { name: "Virat FC", budget: 100 },
            { name: "Neimesis eSports", budget: 100 },
            { name: "Team ICONIC", budget: 100 },
            { name: "Bluster FC", budget: 100 },
            { name: "Let it go na", budget: 100 },
            { name: "Skystrikers United", budget: 100 },
            { name: "ELITE MSN", budget: 100 },
            { name: "Visca", budget: 100 },
            { name: "MI CHAMPSS", budget: 100 },
            { name: "PREDETORS TRIO", budget: 100 }
        ];
        await Team.insertMany(teamData);
        res.send("✅ Teams successfully reset and budgets restored to 100L!");
    } catch (e) {
        res.status(500).send("Error resetting teams: " + e.message);
    }
});

app.get('/fix-budgets', async (req, res) => {
    try {
        await Team.updateMany({}, { $set: { budget: 100 } });
        res.send("✅ All Team budgets reset to 100L!");
    } catch (e) {
        res.status(500).send("Error fixing budgets: " + e.message);
    }
});

// --- AUCTION LOGIC & TIMER ---
let auctionState = {
    activePlayerId: null,
    currentBid: 0,
    highestBidder: 'No Bids Yet',
    timeLeft: 60 
};

let timerInterval = null;

function startTimer() {
    clearInterval(timerInterval);
    auctionState.timeLeft = 60;
    
    timerInterval = setInterval(async () => {
        auctionState.timeLeft--;
        if (auctionState.timeLeft <= 0) {
            clearInterval(timerInterval);
            await autoSellPlayer();
        } else {
            io.emit('updateAuction', auctionState);
        }
    }, 1000);
}

async function autoSellPlayer() {
    if (auctionState.activePlayerId && auctionState.highestBidder !== 'No Bids Yet') {
        const price = auctionState.currentBid;
        const teamName = auctionState.highestBidder;

        await Player.findByIdAndUpdate(auctionState.activePlayerId._id, {
            status: 'Sold',
            soldTo: `${teamName} (${price}L)`
        });
        await Team.findOneAndUpdate({ name: teamName }, { $inc: { budget: -price } });

        auctionState = { activePlayerId: null, currentBid: 0, highestBidder: 'No Bids Yet', timeLeft: 0 };
        
        io.emit('updatePlayers', await Player.find());
        io.emit('updateTeams', await Team.find());
        io.emit('updateAuction', auctionState);
        io.emit('newMessage', { sender: "SYSTEM", role: "admin", text: `🔴 SOLD! ${teamName} bought the player.` });
    } else {
        auctionState = { activePlayerId: null, currentBid: 0, highestBidder: 'No Bids Yet', timeLeft: 0 };
        io.emit('updateAuction', auctionState);
    }
}

// --- SOCKETS ---
io.on('connection', async (socket) => {
    console.log('User Connected:', socket.id);

    socket.emit('initialData', {
        players: await Player.find(),
        teams: await Team.find(),
        chats: await Chat.find().sort({ timestamp: 1 }).limit(50),
        state: auctionState
    });

    socket.on('addPlayer', async (data) => {
        try {
            const newPlayer = new Player({
                name: data.name,
                strength: Number(data.strength), 
                cardType: data.cardType,
                baseValue: Number(data.baseValue),
                status: 'Available',
                soldTo: '-'
            });
            await newPlayer.save();
            io.emit('updatePlayers', await Player.find()); 
        } catch (err) { console.error(err); }
    });

    socket.on('startAuction', async ({ playerId, baseValue }) => {
        const player = await Player.findById(playerId);
        if (player) {
            auctionState = { activePlayerId: player, currentBid: baseValue, highestBidder: 'No Bids Yet', timeLeft: 60 };
            io.emit('updateAuction', auctionState);
            startTimer();
        }
    });

    socket.on('placeBid', async ({ teamName, increment }) => {
        console.log(`Bid Attempt: ${teamName} +${increment}`);
        const team = await Team.findOne({ name: teamName });
        
        if (!team) {
            console.log("❌ Bid Failed: Team not found in Database!");
            return;
        }

        const newBid = auctionState.currentBid + increment;

        if (team.budget >= newBid) {
            auctionState.currentBid = newBid;
            auctionState.highestBidder = teamName;
            startTimer(); 
            io.emit('updateAuction', auctionState);
        } else {
            console.log("❌ Bid Failed: Low Budget");
        }
    });

    socket.on('sellPlayer', autoSellPlayer);

    socket.on('cancelAuction', () => {
        clearInterval(timerInterval);
        auctionState = { activePlayerId: null, currentBid: 0, highestBidder: 'No Bids Yet', timeLeft: 0 };
        io.emit('updateAuction', auctionState);
    });

    socket.on('sendMessage', async (data) => {
        const newMessage = new Chat(data);
        await newMessage.save();
        io.emit('newMessage', data);
    });

    socket.on('deletePlayer', async (playerId) => {
        try {
            await Player.findByIdAndDelete(playerId);
            io.emit('updatePlayers', await Player.find()); 
        } catch (err) { console.error(err); }
    });
});

server.listen(process.env.PORT || 3000, () => console.log("Server Running"));
