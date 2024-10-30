import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import mongoose from "mongoose";
import Slot from './api/models/slot.model.js';
import axios from "axios";
// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables.
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

mongoose.connect(process.env.MONGO_URI);
const db = mongoose.connection;
db.on("error", (err) => {
  console.log(err);
});

db.once("open", () => {
  console.log("Database Connected");
});


// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const SYSTEM_MESSAGE = `Go slow. Make sure you understand the input from the user in a deep and nuanced way. Ask for clarification to enable a concise response. If user start speaking in between your response than stop speaking and ask user their user. If user provide some uncomplete response than ask user to provide the complete query like( sir you were saying something can you please complete it). 

Keep Scope Queries: If a user responds with something outside the given parameters, handle it correctly on your own. After processing their out-of-scope query, ask for confirmation if there is anything else and if they need assistance, go ahead with further queries.

/Additional Instructions`;
const VOICE = 'alloy';
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment

// List of Event Types to log to the console. See the OpenAI Realtime API Documentation: https://platform.openai.com/docs/api-reference/realtime
const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created'
];

// Show AI response elapsed timing calculations
const SHOW_TIMING_MATH = false;

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Route for Twilio to handle incoming calls
// <Say> punctuation to improve text-to-speech translation
fastify.all('/incoming-call', async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say>Please wait while we connect your call to the A. I. voice assistant, powered by Twilio and the Open-A.I. Realtime API</Say>
                              <Pause length="1"/>
                              <Say>O.K. you can start talking!</Say>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;

    reply.type('text/xml').send(twimlResponse);
});

const tools = [
  {
    type: "function",
    name: "calculate_sum",
    description:
      "Use this function when asked to add numbers together, for example when asked 'What's 4 + 6'?",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a", "b"],
    },
  },
  {
    type: "function",
    name: "get_current_time",
    description:
      "Use this function to retrieve the current date and time in ISO format.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "check_available_slots",
    description:
      "Use this function to check for available booking slots in the system.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "book_slot",
    description:
      "Use this function to book a specific slot. Provide the slot ID to book the slot.",
    parameters: {
      type: "object",
      properties: {
        slotId: { type: "string", description: "The ID of the slot to book" },
      },
      required: ["slotId"],
    },
  },
];

const functions = {
  calculate_sum: (args) => args.a + args.b,

  get_current_time: () => {
    const currentTimeIST = new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
    });
    return { currentTime: currentTimeIST };
  },

  check_available_slots: async (args) => {
    const { date, time } = args;
    try {
      const availableSlot = await Slot.findOne({ date, time, isBooked: false });
      if (availableSlot) {
        return {
          available: true,
          slot: availableSlot,
          message: "Slot is available.",
        };
      } else {
        return {
          available: false,
          message: "Slot is not available or already booked.", 
        };
      }
    } catch (error) {
      console.error("Error checking slot availability:", error);
      return { error: "Error checking slot availability" };
    }
  },

  book_slot: async (args) => {
    const { slotId } = args;
    try {
      const slot = await Slot.findOne({ _id: slotId, isBooked: false });
      if (slot) {
        slot.isBooked = true;
        await slot.save();
        return { success: true, message: "Slot booked successfully." };
      } else {
        return {
          success: false,
          message: "Slot not available or already booked.",
        };
      }
    } catch (error) {
      console.error("Error booking slot:", error);
      return { error: "Error booking slot" };
    }
  },
};

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        // Connection-specific state
        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        // Control initial session with OpenAI
        const initializeSession = () => {
            const sessionUpdate = {
              type: "session.update",
              session: {
                turn_detection: { type: "server_vad" },
                input_audio_format: "g711_ulaw",
                output_audio_format: "g711_ulaw",
                voice: VOICE,
                instructions: SYSTEM_MESSAGE,
                modalities: ["text", "audio"],
                temperature: 0.8,
                tools: tools, // New
                tool_choice: "auto", // New
              },
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));

            // Uncomment the following line to have AI speak first:
            // sendInitialConversationItem();
        };

        // Send initial conversation item if AI talks first
        const sendInitialConversationItem = () => {
            const initialConversationItem = {
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: 'Hello and Welcome to ABC Real Estate. How can i assist you today?"'
                        }
                    ]
                }
            };

            if (SHOW_TIMING_MATH) console.log('Sending initial conversation item:', JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

        // Handle interruption when the caller's speech starts
        const handleSpeechStartedEvent = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
                if (SHOW_TIMING_MATH) console.log(`Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`);

                if (lastAssistantItem) {
                    const truncateEvent = {
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime
                    };
                    if (SHOW_TIMING_MATH) console.log('Sending truncation event:', JSON.stringify(truncateEvent));
                    openAiWs.send(JSON.stringify(truncateEvent));
                }

                connection.send(JSON.stringify({
                    event: 'clear',
                    streamSid: streamSid
                }));

                // Reset
                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
            }
        };

        // Send mark messages to Media Streams so we know if and when AI response playback is finished
        const sendMark = (connection, streamSid) => {
            if (streamSid) {
                const markEvent = {
                    event: 'mark',
                    streamSid: streamSid,
                    mark: { name: 'responsePart' }
                };
                connection.send(JSON.stringify(markEvent));
                markQueue.push('responsePart');
            }
        };

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(initializeSession, 100);
        });

        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
        openAiWs.on('message', async (data) => {
            try {
                const response = JSON.parse(data);
                if (response.type === "response.function_call_arguments.done") {
                  console.log(`Received event: ${response.type}`, response);
                }
                

                  if (
                    response.type === "response.function_call_arguments.done"
                  ) {
                    const function_name = response.name;
                    const function_arguments = JSON.parse(response.arguments);

                    // Check if function call is requested
                    // if (item.type === "function_call") {
                      // Find the function in functionsMap by name
                       const result =
                         functions[function_name](function_arguments);

                    if (result) {
                      // Execute the function asynchronously
                          const functionOutputEvent = {
                            type: "conversation.item.create",
                            item: {
                              type: "function_call_output",
                              call_id: response.call_id,
                              output: JSON.stringify(result),
                            },
                          };
                          openAiWs.send(JSON.stringify(functionOutputEvent));

                          // Request another response from OpenAI
                          openAiWs.send(
                            JSON.stringify({ type: "response.create" })
                          );
                      //   }
                    }
                  }
                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));

                    // First delta from a new response starts the elapsed time counter
                    if (!responseStartTimestampTwilio) {
                        responseStartTimestampTwilio = latestMediaTimestamp;
                        if (SHOW_TIMING_MATH) console.log(`Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`);
                    }

                    if (response.item_id) {
                        lastAssistantItem = response.item_id;
                    }
                    
                    sendMark(connection, streamSid);
                }

                if (response.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (SHOW_TIMING_MATH) console.log(`Received media message with timestamp: ${latestMediaTimestamp}ms`);
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('Incoming stream has started', streamSid);

                        // Reset start and media timestamp on a new stream
                        responseStartTimestampTwilio = null; 
                        latestMediaTimestamp = 0;
                        break;
                    case 'mark':
                        if (markQueue.length > 0) {
                            markQueue.shift();
                        }
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        // Handle connection close
        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected.');
        });

        // Handle WebSocket close and errors
        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});