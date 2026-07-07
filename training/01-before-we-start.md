# Part 1: Before We Start

*From: Learning Mastra by Watching a Software Factory Run — a plain-language introduction to Mastra, taught through the Delivery Engine project.*

### Who this is for

This guide assumes you know almost nothing about AI. You do not need to be a programmer to follow most of it, though a little coding experience helps in the middle sections. Every time a new term shows up, I will stop and explain it. If you already know a term, skip the explanation and keep moving.

### What we're going to do

Most introductions to AI frameworks teach you features one at a time, in a vacuum. "Here is an agent. Here is a tool. Here is memory." That's like learning carpentry by reading a catalog of saws. You memorize the parts but you never see a house get built.

We're going to do the opposite. We're going to walk through one complete, real project — a system I'll call the **Delivery Engine** — and let it teach us the framework. The Delivery Engine is built on **Mastra** ([mastra.ai](https://mastra.ai)), an open-source TypeScript framework for building AI applications. By the end, you'll understand what Mastra gives you and, more importantly, *why* each piece exists.

### What the example project does

Here is the whole idea in one paragraph:

> You write a short document, in plain English, describing a small web application you want — "I want a tiny link-counting service for my newsletter." You point the Delivery Engine at a folder containing that document. The engine then plans the work, reviews the plan, writes the code, tests it, and prepares it for deployment — with AI doing the *thinking* and ordinary computer code doing the *checking*. When it finishes, you have a working application, plus a complete paper trail showing what was done, what was verified, and what was judged.

In other words: it's a software factory. AI workers do the labor. But the factory floor is full of rules, inspections, checklists, and quality gates — and those are written in plain, boring, reliable code.

That last sentence is the most important one in this guide. Hold onto it.

### One piece of vocabulary before anything else: the "harness"

You'll hear the word **harness** throughout this guide, so let's define it now.

A harness is everything you build *around* an AI model to keep it safe, honest, and productive. The model is the horse; the harness is the straps, the reins, the blinders, and the cart. A horse without a harness is impressive but useless for hauling. A harness without a horse doesn't move. You need both.

The Delivery Engine is, at its core, a harness. It's an opinionated set of rules, boundaries, checks, and feedback loops wrapped around AI models so that they produce software you can actually trust. Mastra is the framework that makes building such a harness practical.

### Where this project came from

The Delivery Engine started life as a different project called *claude-environments*, built for a specific AI product (Anthropic's Claude Code). The author took years of professional judgment — how to plan software, how to review it, what makes code trustworthy, what mistakes AI coders make — and encoded it as rules and checklists for that one tool.

This project is a port of those ideas into Mastra. The difference matters: instead of the judgment living in configuration files for one vendor's product, it now lives in **first-class framework objects** — agents, workflows, tools, scorers, and evaluation suites — that any part of the system can inspect, test, and reuse. We'll see exactly what each of those words means shortly.
