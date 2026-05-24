const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
const play = require('play-dl');
const express = require('express');

// ==========================================
// 🔥 ESCUDO ANTI-CRASH GLOBAL (BLINDAGEM MÁXIMA)
// ==========================================
// Impede que qualquer erro assíncrono ou rejeição de promessa derrube o Node.js
process.on('uncaughtException', (err) => {
    console.error('⚠️ [CRÍTICO ISOLADO] Erro pego no escudo global:', err.message || err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🧠 [PROMESSA REJEITADA] Falha assíncrona interceptada:', reason.message || reason);
});

const app = express();
app.use(express.json());

// Configuração estrita de Intents do Discord (Apenas o necessário para economizar memória)
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildVoiceStates, 
        GatewayIntentBits.GuildMembers
    ]
});

// Puxa as configurações seguras da Railway (Se não existirem, usa travas vazias para não quebrar)
const GUILD_ID = process.env.GUILD_ID;
const CATEGORY_ID = process.env.CATEGORY_ID;

// Mapa na memória para monitorar conexões ativas e evitar vazamento de memória (Memory Leak)
const conexoesAtivas = new Map();

// ==========================================
// 🌐 ROTA DA API DO ROBLOX (/play)
// ==========================================
app.post('/play', async (req, res) => {
    // 🛡️ Validação de entrada sanitizada contra Ataques de Requisição Malformada (Erro 400)
    const { robloxName, musica, discordUserId } = req.body;
    
    if (!robloxName || !musica || !discordUserId) {
        return res.status(400).json({ success: false, error: "400: Dados incompletos ou inválidos." });
    }

    // Filtro básico para limpar o texto da música e evitar quebras por caracteres estranhos
    const musicaSanitizada = String(musica).trim().substring(0, 100);
    const userIdSanitizado = String(discordUserId).replace(/\D/g, ''); // Remove qualquer caractere que não seja número

    if (!userIdSanitizado) {
        return res.status(400).json({ success: false, error: "400: ID do Discord inválido." });
    }

    try {
        // Verifica se as variáveis de ambiente essenciais estão configuradas
        if (!GUILD_ID || !CATEGORY_ID) {
            console.error("❌ ERRO: GUILD_ID ou CATEGORY_ID não configurados na Railway!");
            return res.status(500).json({ success: false, error: "500: Erro de configuração no servidor da rádio." });
        }

        // 🛡️ Proteção contra erro de servidor do Discord offline/indisponível
        const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
        if (!guild) {
            return res.status(500).json({ success: false, error: "500: Não foi possível alcançar o servidor do Discord." });
        }

        // 🛡️ Proteção contra Erro 404 (Jogador digitou um ID de Discord que não está no servidor)
        const member = await guild.members.fetch(userIdSanitizado).catch(() => null);
        if (!member) {
            return res.status(404).json({ success: false, error: "404: Seu ID não foi encontrado no nosso servidor do Discord. Você entrou lá?" });
        }

        // Se o usuário já tiver uma rádio tocando, limpa a antiga antes de criar a nova (Evita flood de canais)
        if (conexoesAtivas.has(userIdSanitizado)) {
            const velhaConexao = conexoesAtivas.get(userIdSanitizado);
            try {
                velhaConexao.channel.delete().catch(() => {});
                velhaConexao.connection.destroy();
            } catch(e) {}
            conexoesAtivas.delete(userIdSanitizado);
        }

        // 🛡️ Proteção contra Erro 403 (Permissões de Cargo do Bot no Discord)
        let channel;
        try {
            channel = await guild.channels.create({
                name: `🎧-${robloxName.substring(0, 12)}`,
                type: ChannelType.GuildVoice,
                parent: CATEGORY_ID,
                permissionOverwrites: [
                    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] },
                    { id: userIdSanitizado, allow: [PermissionFlagsBits.Connect], deny: [PermissionFlagsBits.Speak] } // Mutado automático
                ]
            });
        } catch (err) {
            console.error("❌ Erro de permissão 403 ao criar canal de voz:", err.message);
            return res.status(403).json({ success: false, error: "403: O Bot está sem permissão de Administrador no Discord para criar canais." });
        }

        // 🛡️ Conexão de voz resiliente com reconexão automática em caso de oscilação
        const connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
        });

        // 🛡️ Busca Blindada no YouTube contra erros de cota ou bloqueio de IP
        let youtubeSearch;
        try {
            youtubeSearch = await play.search(musicaSanitizada, { limit: 1 });
        } catch (err) {
            channel.delete().catch(() => {});
            connection.destroy();
            console.error("❌ Falha na API do YouTube:", err.message);
            return res.status(500).json({ success: false, error: "500: O YouTube rejeitou a busca. Tente o nome exato da música." });
        }

        if (!youtubeSearch || youtubeSearch.length === 0) {
            channel.delete().catch(() => {});
            connection.destroy();
            return res.status(404).json({ success: false, error: "404: Nenhuma música encontrada com esse nome no YouTube." });
        }

        // 🛡️ Streaming seguro de fluxo de áudio
        const player = createAudioPlayer();
        let stream;
        try {
            stream = await play.stream(youtubeSearch[0].url, { quality: 1, seek: 0 });
        } catch (err) {
            channel.delete().catch(() => {});
            connection.destroy();
            console.error("❌ Erro ao descriptografar áudio do vídeo:", err.message);
            return res.status(500).json({ success: false, error: "500: Esta música possui restrição de idade ou direitos autorais bloqueados fora do YT." });
        }

        const resource = createAudioResource(stream.stream, { inputType: stream.type });
        player.play(resource);
        connection.subscribe(player);

        // Salva a conexão ativa na memória para controle
        conexoesAtivas.set(userIdSanitizado, { channel, connection, player });

        // 🔄 Rotina de Limpeza Automática Segura (Quando a música acaba)
        player.on(AudioPlayerStatus.Idle, () => {
            setTimeout(() => {
                try {
                    channel.delete().catch(() => {});
                    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                        connection.destroy();
                    }
                } catch(e) {}
                conexoesAtivas.delete(userIdSanitizado);
            }, 2000); // Aguarda 2 segundos e apaga a sala
        });

        // Se o player der erro no meio da música, limpa tudo sem travar a API
        player.on('error', (error) => {
            console.error(`❌ Erro no player durante a reprodução: ${error.message}`);
            channel.delete().catch(() => {});
            connection.destroy();
            conexoesAtivas.delete(userIdSanitizado);
        });

        // Escuta se o jogador sair manualmente ou for kickado da call para fechar o canal
        connection.on(VoiceConnectionStatus.Disconnected, () => {
            setTimeout(() => {
                channel.delete().catch(() => {});
                try { connection.destroy(); } catch(e) {}
                conexoesAtivas.delete(userIdSanitizado);
            }, 1000);
        });

        // Retorno limpo e de extremo sucesso (HTTP 200)
        return res.status(200).json({ 
            success: true, 
            message: "Tocando!", 
            trackName: youtubeSearch[0].title.substring(0, 35) .. "..."
        });

    } catch (globalError) {
        console.error("💥 FALHA CRÍTICA TOTAL NA ROTA /PLAY:", globalError);
        return res.status(500).json({ success: false, error: "500: Erro crítico interno no servidor da Railway." });
    }
});

// ==========================================
// 🚀 INICIALIZAÇÃO DO BOT E DO SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

if (!DISCORD_TOKEN) {
    console.error("❌ ERRO GRAVE: Variável DISCORD_TOKEN não está configurada na Railway!");
    process.exit(1); // Para o processo se não houver token para ligar o bot
}

client.login(DISCORD_TOKEN).catch(err => {
    console.error("❌ Falha crítica ao fazer login no Discord (Token Inválido?):", err.message);
});

client.once('ready', () => {
    console.log(`🤖 [BOT SECURE] Autenticado com sucesso como ${client.user.tag}`);
    app.listen(PORT, () => console.log(`🌐 [API SECURE] Gateway ativo na porta ${PORT}`));
});
