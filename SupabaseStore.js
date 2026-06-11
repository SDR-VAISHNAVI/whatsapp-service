class SupabaseStore {
    constructor(supabase) {
        this.supabase = supabase;
    }

    async sessionExists({ session }) {
        const { data } = await this.supabase
            .from('whatsapp_sessions')
            .select('id')
            .eq('id', session)
            .single();
        return !!data;
    }

    async save({ session }) {
        const { error } = await this.supabase
            .from('whatsapp_sessions')
            .upsert({ id: session, updated_at: new Date() });
        if (error) throw error;
    }

    async extract({ session, path }) {
        const { data, error } = await this.supabase
            .from('whatsapp_sessions')
            .select('session')
            .eq('id', session)
            .single();
        if (error || !data) throw new Error('Session not found');
        require('fs').writeFileSync(path, data.session);
    }

    async delete({ session }) {
        await this.supabase
            .from('whatsapp_sessions')
            .delete()
            .eq('id', session);
    }
}

module.exports = SupabaseStore;
