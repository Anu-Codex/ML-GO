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

// --- AUCTION LOGIC & TIMER ---
let auctionState = {
    activePlayerId: null,
    currentBid: 0,
    highestBidder: 'No Bids Yet',
    timeLeft: 60 // The 60-second clock
};

let timerInterval = null;

function startTimer() {
    clearInterval(timerInterval);
    auctionState.timeLeft = 60; // Reset to 60
    
    timerInterval = setInterval(async () => {
        auctionState.timeLeft--;
        
        if (auctionState.timeLeft <= 0) {
            clearInterval(timerInterval);
            await autoSellPlayer(); // Auto-sell when time hits 0
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
        // If time ran out with no bids
        auctionState = { activePlayerId: null, currentBid: 0, highestBidder: 'No Bids Yet', timeLeft: 0 };
        io.emit('updateAuction', auctionState);
    }
}

// --- SOCKETS ---
io.on('connection', async (socket) => {
    socket.emit('initialData', {
        players: await Player.find(),
        teams: await Team.find(),
        chats: await Chat.find().sort({ timestamp: 1 }).limit(50),
        state: auctionState
    });
    // --- Inside io.on('connection', (socket) => { ... ---

    socket.on('addPlayer', async (data) => {
        try {
            console.log("📥 Received Player Data:", data);

            // 1. Create the document
            const newPlayer = new Player({
                name: data.name,
                strength: Number(data.strength), // Matches OVR in FC Mobile
                cardType: data.cardType,
                baseValue: Number(data.baseValue),
                status: 'Available',
                soldTo: '-'
            });

            // 2. Save to MongoDB
            await newPlayer.save();
            console.log("✅ Player Saved to DB!");

            // 3. Fetch ALL players and broadcast to EVERYONE
            const allPlayers = await Player.find();
            io.emit('updatePlayers', allPlayers); 
            
            // 4. Send a chat message automatically
            io.emit('newMessage', { 
                sender: "SYSTEM", 
                role: "admin", 
                text: `🆕 ${data.name} (${data.strength} OVR) added to the roster!` 
            });

        } catch (err) {
            console.error("❌ ERROR SAVING PLAYER:", err);
        }
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
        const team = await Team.findOne({ name: teamName });
        const newBid = auctionState.currentBid + increment;

        if (team && team.budget >= newBid) {
            auctionState.currentBid = newBid;
            auctionState.highestBidder = teamName;
            startTimer(); // THIS RESETS THE 60 SECONDS
            io.emit('updateAuction', auctionState);
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
});
// --- Inside io.on('connection', (socket) => { ---
    // ADD THIS EXACT BLOCK:
    socket.on('deletePlayer', async (playerId) => {
        try {
            console.log("📥 Delete request received for ID:", playerId);
            
            // Validate the ID exists
            if (!playerId) {
                console.error("❌ No Player ID provided!");
                return;
            }

            // Perform the deletion
            const deleted = await Player.findByIdAndDelete(playerId);
            
            if (deleted) {
                console.log(`✅ Player ${deleted.name} removed from DB`);
                
                // Get the new list and tell EVERYONE to refresh
                const allPlayers = await Player.find();
                io.emit('updatePlayers', allPlayers); 
            } else {
                console.log("⚠️ Player not found in DB.");
            }
        } catch (err) {
            console.error("❌ Server Error during delete:", err);
        }
    });

    // ... rest of your code ...
});

server.listen(process.env.PORT || 3000, () => console.log("Server Running"));
