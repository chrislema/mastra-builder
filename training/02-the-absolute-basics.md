# Part 2: The Absolute Basics — Models, Prompts, and Why We Can't Just Trust Them

*From: Learning Mastra by Watching a Software Factory Run — a plain-language introduction to Mastra, taught through the Delivery Engine project.*

### What is an AI model?

The AI systems we're talking about are called **large language models**, or **LLMs**. An LLM is a computer program trained on enormous amounts of text. Its one skill is this: given some text, predict what text should come next. That sounds narrow, but it turns out that "predict good next text" covers an astonishing range of abilities — answering questions, writing essays, summarizing documents, and yes, writing computer code.

When you use ChatGPT or Claude, you are talking to an LLM.

A few terms you'll see:

- A **prompt** is the text you send to the model. It can be a question, an instruction, a document, or all three at once.
- The **response** (or **completion**) is the text the model sends back.
- **Tokens** are the small chunks of text (roughly word-fragments) that models read and write. Models are priced by the token, which is why long conversations cost more money than short ones. Remember this — it explains several design choices later.
- A **model provider** is a company that runs models and sells access to them — OpenAI, Anthropic, Google, and others. You typically talk to their models over the internet through an **API** (Application Programming Interface — a way for one program to talk to another).

### The one thing you must understand about LLMs

LLMs are *confident narrators, not reliable ones.*

A model will tell you, in fluent and reassuring prose, that it finished a task, that the tests passed, that the code works. Sometimes that's true. Sometimes the model is wrong and doesn't know it. Sometimes it produces something that *looks* exactly like a correct answer but isn't. People call these failures **hallucinations**, but for building systems, the more useful framing is this:

> **A model's claim is not evidence. Only evidence is evidence.**

The entire Delivery Engine is organized around that sentence. When an AI worker says "I implemented the feature," the engine does not believe it. It checks: did files actually change? Does the code actually compile? Does the running application actually answer requests? The model's confident summary counts for nothing until real proof exists.

You'll see this principle — the project calls it **"evidence over confident narration"** — enforced by machinery again and again.

### So why use models at all?

Because they're genuinely good at the things code is bad at: reading a messy human document and figuring out what the person wants, breaking a vague goal into concrete steps, writing new code that didn't exist before, judging whether a plan "makes sense." These are **judgment tasks**. No ordinary program can do them.

The trick — the whole craft of this field — is dividing the work correctly:

- **Judgment goes to the model.** Understanding intent, planning, writing, reviewing, scoring quality.
- **Everything mechanical goes to code.** Checking rules, counting things, enforcing boundaries, running tests, doing math, keeping records.

The Delivery Engine states this as an explicit design law, which its documentation calls the **sorting principle**:

1. If a rule is **deterministic and blockable** → enforce it with code (tools, checks, hooks). *Deterministic* means it always gives the same answer for the same input — no opinion involved.
2. If a rule is **judgment but gradeable** → measure it with a rubric and a scoring system (we'll meet these).
3. If a rule is **judgment and generative** (it produces new work) → give it to an AI agent with good instructions.

Keep that three-way sort in mind. Almost every component we're about to meet exists to serve one of those three lines.
