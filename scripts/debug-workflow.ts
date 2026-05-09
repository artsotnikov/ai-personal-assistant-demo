
import 'dotenv/config';
import { db } from '../server/db';
import { messageProcessingRuns } from '@shared/schema';
import { desc } from 'drizzle-orm';

async function debugWorkflow() {
    console.log('🔍 Fetching latest workflow runs...');

    try {
        const runs = await db.select()
            .from(messageProcessingRuns)
            .orderBy(desc(messageProcessingRuns.id))
            .limit(5);

        if (runs.length === 0) {
            console.log('⚠️ No workflow runs found.');
            return;
        }

        console.log(`Found ${runs.length} runs. Showing details for the most recent ones:\n`);

        for (const run of runs) {
            console.log(`--------------------------------------------------`);
            console.log(`📋 Run ID: ${run.id} | Message ID: ${run.messageId}`);
            console.log(`📅 Started: ${run.startedAt?.toLocaleString()}`);
            console.log(`🏁 Status: ${run.status?.toUpperCase()}`);
            console.log(`⏱️ Duration: ${run.totalDurationMs}ms`);
            console.log(`🤖 Agent: ${run.agentUsed || 'N/A'}`);

            if (run.errorMessage) {
                console.log(`❌ Error Message: ${run.errorMessage}`);
            }

            console.log('\nSteps:');
            const steps = run.steps as any[];
            if (Array.isArray(steps) && steps.length > 0) {
                steps.forEach((step: any, index: number) => {
                    const statusIcon = step.status === 'completed' ? '✅' : step.status === 'error' ? '❌' : '⏳';
                    const duration = step.durationMs ? `${step.durationMs}ms` : (step.status === 'running' ? 'RUNNING' : '');
                    console.log(`  ${index + 1}. ${statusIcon} [${step.stepName}] - ${step.status} ${duration ? `(${duration})` : ''}`);
                    if (step.error) {
                        console.log(`     🔴 Error: ${step.error}`);
                    }
                });
            } else {
                console.log('  (No steps recorded)');
            }
            console.log(`\n`);
        }

    } catch (error) {
        console.error('Failed to fetch workflow runs:', error);
    } finally {
        process.exit(0);
    }
}

debugWorkflow();
