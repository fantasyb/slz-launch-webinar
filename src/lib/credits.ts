import { db } from './db';

export class InsufficientCreditsError extends Error {
  balance: number;
  required: number;
  constructor(balance: number, required: number) {
    super(`Insufficient credits: have ${balance}, need ${required}`);
    this.name = 'InsufficientCreditsError';
    this.balance = balance;
    this.required = required;
  }
}

interface TransferParams {
  fromAgentId: string;
  toAgentId: string;
  amount: number;
  type: string;
  referenceId?: string;
  referenceType?: string;
  description: string;
}

export async function transferCredits(params: TransferParams) {
  const { fromAgentId, toAgentId, amount, type, referenceId, referenceType, description } = params;

  if (amount <= 0) throw new Error('Transfer amount must be positive');

  return db.$transaction(async (tx) => {
    // Lock sender row by reading + updating atomically
    const sender = await tx.agent.findUniqueOrThrow({ where: { id: fromAgentId } });

    if (sender.credits < amount) {
      throw new InsufficientCreditsError(sender.credits, amount);
    }

    const updatedSender = await tx.agent.update({
      where: { id: fromAgentId },
      data: { credits: { decrement: amount } },
    });

    const updatedReceiver = await tx.agent.update({
      where: { id: toAgentId },
      data: { credits: { increment: amount } },
    });

    const transaction = await tx.transaction.create({
      data: {
        type,
        amount,
        fromAgentId,
        toAgentId,
        referenceId,
        referenceType,
        description,
        balanceAfterFrom: updatedSender.credits,
        balanceAfterTo: updatedReceiver.credits,
      },
    });

    return transaction;
  });
}

export async function validateBalance(agentId: string, requiredAmount: number): Promise<boolean> {
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { credits: true } });
  return (agent?.credits ?? 0) >= requiredAmount;
}

export async function awardBonus(agentId: string, amount: number, description: string) {
  return db.$transaction(async (tx) => {
    const updated = await tx.agent.update({
      where: { id: agentId },
      data: { credits: { increment: amount } },
    });

    return tx.transaction.create({
      data: {
        type: 'bonus',
        amount,
        toAgentId: agentId,
        description,
        balanceAfterTo: updated.credits,
      },
    });
  });
}

export async function getTransactionHistory(
  agentId: string,
  options: { limit?: number; offset?: number; type?: string } = {}
) {
  const { limit = 50, offset = 0, type } = options;

  const where = {
    OR: [{ fromAgentId: agentId }, { toAgentId: agentId }],
    ...(type ? { type } : {}),
  };

  const [transactions, total] = await Promise.all([
    db.transaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    db.transaction.count({ where }),
  ]);

  return { transactions, total };
}

export async function getBalance(agentId: string): Promise<number> {
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { credits: true } });
  return agent?.credits ?? 0;
}

// Reputation milestone bonuses
const MILESTONES = [
  { threshold: 25, bonus: 50 },
  { threshold: 50, bonus: 100 },
  { threshold: 75, bonus: 200 },
  { threshold: 90, bonus: 500 },
];

export async function checkAndAwardMilestones(agentId: string, reputationScore: number) {
  for (const { threshold, bonus } of MILESTONES) {
    if (reputationScore >= threshold) {
      // Check if already awarded
      const existing = await db.transaction.findFirst({
        where: {
          toAgentId: agentId,
          type: 'bonus',
          description: `Reputation milestone: ${threshold}`,
        },
      });
      if (!existing) {
        await awardBonus(agentId, bonus, `Reputation milestone: ${threshold}`);
      }
    }
  }
}
