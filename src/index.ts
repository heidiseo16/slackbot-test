import { App } from "@slack/bolt";
import { MessageElement } from "@slack/web-api/dist/types/response/ConversationsHistoryResponse";
import { OpenAI } from "openai";

const dotenv = require("dotenv");

dotenv.config({
  path: [".env.local", ".env", ".env.development.local", ".env.development"],
});

// Set your OpenAI and Slack tokens as environment variables
const openaiApiKey = process.env.OPENAI_API_KEY as string;
const slackToken = process.env.SLACK_BOT_TOKEN as string;
const slackSigningSecret = process.env.SLACK_SIGNING_SECRET as string;
const organization = process.env.OPENAI_ORGANIZATION_ID as string;
const project = process.env.OPENAI_PROJECT_ID as string;

if (process.env.NODE_ENV === "development") {
  console.log("OpenAI API Key:", openaiApiKey);
  console.log("Slack Bot Token:", slackToken);
  console.log("Slack Signing Secret:", slackSigningSecret);
  console.log("OpenAI Organization ID:", organization);
  console.log("OpenAI Project ID:", project);
}

const openai = new OpenAI({
  organization,
  project,
  apiKey: openaiApiKey,
});

const app = new App({
  token: slackToken,
  signingSecret: slackSigningSecret,
});

interface SlackMessage {
  text: string;
  user: string;
  channel: string;
  thread_ts?: string;
}

async function fetchRecentMessages(
  channelId: string,
  limit: number = 10,
  thread_ts?: string
): Promise<SlackMessage[]> {
  try {
    let result;
    if (thread_ts) {
      result = await app.client.conversations.replies({
        channel: channelId,
        ts: thread_ts,
        limit: limit,
      });
    } else {
      result = await app.client.conversations.history({
        channel: channelId,
        limit: limit,
      });
    }

    if (result.messages) {
      const s: MessageElement[] = result.messages as MessageElement[];
      return result.messages as SlackMessage[];
    } else {
      return [];
    }
  } catch (error) {
    console.error(`Error fetching messages: ${error}`);
    return [];
  }
}

// const systemPrompt = (
//   question?: string
// ): {
//   role: "system";
//   content: string;
// } => {
//   if (question) {
//     return {
//       role: "system",
//       content: question,
//     };
//   } else {
//     return {
//       role: "system",
//       content:
//         "You are a helpful assistant. You will summarize the conversation using the same language of the speakers, which will be one of Korean or English. You should answer the question if the last message starts with @#*&. The summary result should contain speaker names from original messages.",
//     };
//   }
// };

const systemPrompt = (
  question?: string
): {
  role: "system";
  content: string;
} => {
  return {
    role: "system",
    content:
      "You are a helpful assistant. You will summarize the conversation using Korean only. You should answer the question if the last message starts with `@#*&Question: ` else you just create a helpful summary WITHOUT ORIGINAL MESSAGES. The summary should contain speaker names. Do not include the messages directly in the summary.",
  };
};

//@#*&

async function getUserMap(users: string[]): Promise<Map<string, string>> {
  const userMap = new Map<string, string>();
  for (const user of users) {
    const userInfo = await app.client.users.info({
      user: user,
    });
    userMap.set(user, userInfo.user?.name || "Unknown");
  }
  return userMap;
}

async function summarizeText(
  chats: SlackMessage[],
  question?: string
): Promise<string> {
  try {
    const usersMap = await getUserMap(chats.map((chat) => chat.user));
    const messages: {
      role: "user";
      content: string;
      user: string;
    }[] = [];
    for (const chat of chats) {
      if (chat.text.startsWith("!summarize")) {
        continue;
      }
      const speaker = usersMap.get(chat.user) || "Unknown";
      if (speaker === "summarizer") {
        continue;
      }
      if (chat.text.startsWith("<@U07AF4DJWRH>")) {
        // ignore commands
        continue;
      }
      for (const userId of Object.keys(usersMap)) {
        chat.text = chat.text.replace(
          `<@${userId}>`,
          usersMap.get(userId) || "Unknown"
        );
      }
      messages.push({
        role: "user",
        content: `${speaker}: ${chat.text}`,
        user: speaker,
      });
    }
    // console.log(messages.map((m) => m.user + ": " + m.content).join("\n"));
    const systemPrmpt = systemPrompt(question);
    if (question) {
      messages.push({
        role: "user",
        content: `@#*&Question: ${question}`,
        user: "definetly not a bot",
      });
    }
    const chatCompletion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [systemPrmpt, ...messages],
      temperature: 0.5,
    });
    return chatCompletion.choices[0].message.content || "No summary found.";
  } catch (error) {
    console.error(`Error summarizing text: ${error}`);
    return "Error summarizing text.";
  }
}

async function postMessage(
  channelId: string,
  text: string,
  threadTs?: string
): Promise<void> {
  try {
    await app.client.chat.postMessage({
      channel: channelId,
      text: text,
      thread_ts: threadTs,
    });
  } catch (error) {
    console.error(`Error posting message: ${error}`);
  }
}

async function handleSummarizeRequest(
  channelId: string,
  question?: string,
  threadTs?: string,
  limit: number = 10
) {
  const messages = await fetchRecentMessages(channelId, limit, threadTs);
  if (messages.length > 0) {
    const summary = await summarizeText(messages, question);

    await postMessage(channelId, `${summary}`, threadTs);
  }
}

const options: { [key: string]: string } = {
  "--help": "Show help",
  "--version": "Show version",
  "--limit": "Set the limit of messages to summarize",
};

app.event("app_mention", async ({ event, context }) => {
  try {
    const { channel, thread_ts, text } = event;
    console.log("Event: ", text);
    let prompt = text.split(" ").slice(1).join(" ");
    console.log("Prompt: ", prompt);

    if (prompt.trim() === "--help") {
      let helpText =
        "```Usage: @Summarizer [summarize|question] [options]\n If no question is provided but 'summarize', the last 10 messages will be summarized.\n";
      helpText += Object.keys(options)
        .map((key) => `${key}: ${options[key]}`)
        .join("\n");
      helpText += "```";
      await postMessage(event.channel, helpText, thread_ts);
      return;
    }

    if (prompt.trim() === "--version") {
      await postMessage(event.channel, "v1.0.0", thread_ts);
      return;
    }

    let question: string | undefined = undefined;
    let limit = 10;
    if (prompt.includes("--limit")) {
      let parts = prompt.split("--limit");
      prompt = parts[0];
      limit = parseInt(parts[1].trim()) || 10;
    }

    if (prompt.trim() !== "summarize") {
      question = prompt;
    }

    await handleSummarizeRequest(channel, question, thread_ts, limit);
  } catch (error) {
    console.error(`Error handling app_mention event: ${error}`);
  }
});

app.message(
  /!summarize\s*(".*")?\s*([0-9]*)/,
  async ({ context, message, say }) => {
    try {
      const question = context.matches[1];
      const limit = parseInt(context.matches[2]) || 10;
      console.log("Question: ", question);
      console.log("Limit: ", limit);
      const { channel, thread_ts } = message as SlackMessage;
      await handleSummarizeRequest(channel, question, thread_ts, limit);
    } catch (error) {
      console.error(`Error handling message event: ${error}`);
    }
  }
);

(async () => {
  // Start your app
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Slack Bolt app is running on port ${port}!`);
})();
