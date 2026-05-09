
import 'dotenv/config';
import { getOpenRouterModels } from '../server/aiModelsApi';

async function verifySorting() {
    console.log('Fetching OpenRouter models via aiModelsApi...');
    try {
        const models = await getOpenRouterModels();
        console.log(`Total models: ${models.length}`);

        console.log('\nTop 10 models (should be prioritized):');
        models.slice(0, 10).forEach((m, i) => {
            console.log(`${i + 1}. ${m.id}`);
        });

    } catch (e) {
        console.error(e);
    }
}

verifySorting();
