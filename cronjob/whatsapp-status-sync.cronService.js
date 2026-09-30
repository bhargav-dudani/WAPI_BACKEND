import cron from 'node-cron';
import { syncAllActiveWabas } from '../services/whatsapp-status-monitor.service.js';

async function whatsappStatusSyncCronService() {
    // Run every 4 hours
    cron.schedule('0 */4 * * *', async () => {
        console.log('Running WhatsApp Business Account Meta status sync cron job...');
        try {
            await syncAllActiveWabas();
            console.log('WhatsApp Business Account Meta status sync cron job completed.');
        } catch (error) {
            console.error('Error in WhatsApp status sync cron job:', error);
        }
    });

    console.log('WhatsApp Business Account Meta status sync cron job scheduled.');
}

export default whatsappStatusSyncCronService;
