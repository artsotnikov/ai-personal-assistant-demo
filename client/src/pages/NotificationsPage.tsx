import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import ChatHeader from "@/components/chat/ChatHeader";
import {
    Bell, Clock, Send, Moon, Volume2, Save, Loader2,
    Check, AlertCircle, Sun, Calendar, Target, MessageSquare
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";
import { SOUND_OPTIONS, SoundType } from "@/lib/notificationService";

interface NotificationSettings {
    id: number;
    // Расписание
    morningBriefingHour: number;
    morningBriefingMinute: number;
    eveningRecapHour: number;
    eveningRecapMinute: number;
    checkIntervalMinutes: number;
    maxDailyReminders: number;
    cooldownHours: number;
    // Типы
    enableMorningBriefing: boolean;
    enableEveningRecap: boolean;
    enableDeadlineAlerts: boolean;
    // Telegram
    telegramEnabled: boolean;
    telegramBotToken: string | null;
    telegramChatId: string | null;
    hasTelegramToken?: boolean;
    // Тихие часы
    quietHoursEnabled: boolean;
    quietHoursStart: number;
    quietHoursEnd: number;
    quietHoursWeekendOnly: boolean;
    // Браузер
    browserPushEnabled: boolean;
    browserSoundEnabled: boolean;
    browserSoundType: string;
}

export default function NotificationsPage() {
    const [, navigate] = useLocation();
    const [settings, setSettings] = useState<NotificationSettings | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [telegramToken, setTelegramToken] = useState("");
    const [telegramChatId, setTelegramChatId] = useState("");
    const [validating, setValidating] = useState(false);
    const [telegramValid, setTelegramValid] = useState(false);
    const { toast } = useToast();

    useEffect(() => {
        fetchSettings();
    }, []);

    const fetchSettings = async () => {
        try {
            const res = await fetch("/api/notifications/settings");
            if (res.ok) {
                const data = await res.json();
                setSettings(data);
                setTelegramChatId(data.telegramChatId || "");
            }
        } catch (error) {
            console.error("Error:", error);
            toast({ title: "Ошибка загрузки", variant: "destructive" });
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async () => {
        if (!settings) return;
        setSaving(true);

        try {
            const payload = {
                ...settings,
                telegramBotToken: telegramToken || undefined,
                telegramChatId: telegramChatId || settings.telegramChatId,
            };

            const res = await fetch("/api/notifications/settings", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            if (res.ok) {
                toast({ title: "Настройки сохранены" });
                setTelegramToken("");
                fetchSettings();
            } else {
                throw new Error();
            }
        } catch {
            toast({ title: "Ошибка сохранения", variant: "destructive" });
        } finally {
            setSaving(false);
        }
    };

    const handleValidateTelegram = async () => {
        if (!telegramToken || !telegramChatId) {
            toast({ title: "Заполните токен и Chat ID", variant: "destructive" });
            return;
        }

        setValidating(true);
        try {
            const res = await fetch("/api/notifications/telegram/validate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ botToken: telegramToken, chatId: telegramChatId }),
            });
            const data = await res.json();

            if (data.valid) {
                setTelegramValid(true);
                toast({ title: "Telegram подключён!", description: `@${data.botInfo?.username}` });
            } else {
                toast({ title: "Ошибка", description: data.error, variant: "destructive" });
            }
        } catch {
            toast({ title: "Ошибка проверки", variant: "destructive" });
        } finally {
            setValidating(false);
        }
    };

    const update = <K extends keyof NotificationSettings>(key: K, value: NotificationSettings[K]) => {
        setSettings(prev => prev ? { ...prev, [key]: value } : null);
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-screen">
                <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
            </div>
        );
    }

    if (!settings) {
        return <div className="p-4">Ошибка загрузки настроек</div>;
    }

    return (
        <div className="flex flex-col h-screen bg-gray-50 dark:bg-gray-900 overflow-hidden">
            <div className="flex-shrink-0">
                <ChatHeader />
            </div>

            <div className="flex-1 flex flex-col h-full overflow-hidden">
                {/* Sub-header */}
                <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 p-4 shrink-0">
                    <div className="flex items-center justify-between max-w-2xl mx-auto w-full">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-blue-500/10 rounded-lg">
                                <Bell className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                            </div>
                            <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Уведомления</h1>
                        </div>
                        <Button onClick={handleSave} disabled={saving} className="gap-2">
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                            Сохранить
                        </Button>
                    </div>
                </header>

                <main className="flex-1 overflow-y-auto p-4">
                    <div className="max-w-2xl mx-auto space-y-6">
                {/* Расписание */}
                <Section icon={<Clock className="w-5 h-5" />} title="Расписание">
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <Label className="text-xs text-gray-500">Утренняя сводка</Label>
                            <div className="flex gap-1 mt-1">
                                <Input
                                    type="number"
                                    min={0}
                                    max={23}
                                    value={settings.morningBriefingHour}
                                    onChange={e => update('morningBriefingHour', parseInt(e.target.value) || 0)}
                                    className="w-16 text-center"
                                />
                                <span className="self-center">:</span>
                                <Input
                                    type="number"
                                    min={0}
                                    max={59}
                                    step={15}
                                    value={settings.morningBriefingMinute}
                                    onChange={e => update('morningBriefingMinute', parseInt(e.target.value) || 0)}
                                    className="w-16 text-center"
                                />
                                <span className="self-center text-xs text-gray-500">MSK</span>
                            </div>
                        </div>
                        <div>
                            <Label className="text-xs text-gray-500">Вечерний recap</Label>
                            <div className="flex gap-1 mt-1">
                                <Input
                                    type="number"
                                    min={0}
                                    max={23}
                                    value={settings.eveningRecapHour}
                                    onChange={e => update('eveningRecapHour', parseInt(e.target.value) || 0)}
                                    className="w-16 text-center"
                                />
                                <span className="self-center">:</span>
                                <Input
                                    type="number"
                                    min={0}
                                    max={59}
                                    step={15}
                                    value={settings.eveningRecapMinute}
                                    onChange={e => update('eveningRecapMinute', parseInt(e.target.value) || 0)}
                                    className="w-16 text-center"
                                />
                                <span className="self-center text-xs text-gray-500">MSK</span>
                            </div>
                        </div>
                    </div>

                    <div className="mt-4 space-y-3">
                        <div>
                            <div className="flex justify-between text-sm mb-1">
                                <span>Проверка триггеров</span>
                                <span className="text-blue-600 font-medium">{settings.checkIntervalMinutes} мин</span>
                            </div>
                            <Slider
                                value={[settings.checkIntervalMinutes]}
                                onValueChange={v => update('checkIntervalMinutes', v[0])}
                                min={5}
                                max={60}
                                step={5}
                            />
                        </div>
                        <div>
                            <div className="flex justify-between text-sm mb-1">
                                <span>Пауза между напоминаниями</span>
                                <span className="text-blue-600 font-medium">{settings.cooldownHours} ч</span>
                            </div>
                            <Slider
                                value={[settings.cooldownHours]}
                                onValueChange={v => update('cooldownHours', v[0])}
                                min={1}
                                max={12}
                                step={1}
                            />
                        </div>
                        <div>
                            <div className="flex justify-between text-sm mb-1">
                                <span>Лимит уведомлений в день</span>
                                <span className="text-blue-600 font-medium">{settings.maxDailyReminders}</span>
                            </div>
                            <Slider
                                value={[settings.maxDailyReminders]}
                                onValueChange={v => update('maxDailyReminders', v[0])}
                                min={1}
                                max={10}
                                step={1}
                            />
                        </div>
                    </div>
                </Section>

                {/* Типы уведомлений */}
                <Section icon={<Calendar className="w-5 h-5" />} title="Типы уведомлений">
                    <div className="space-y-3">
                        <ToggleRow
                            icon="☀️"
                            label="Утренняя сводка"
                            checked={settings.enableMorningBriefing}
                            onChange={v => update('enableMorningBriefing', v)}
                        />
                        <ToggleRow
                            icon="🌙"
                            label="Вечерний recap"
                            desc="Опционально, по умолчанию выключен"
                            checked={settings.enableEveningRecap}
                            onChange={v => update('enableEveningRecap', v)}
                        />
                        <ToggleRow
                            icon="⏰"
                            label="Алерты о дедлайнах"
                            checked={settings.enableDeadlineAlerts}
                            onChange={v => update('enableDeadlineAlerts', v)}
                        />
                    </div>
                </Section>

                {/* Telegram */}
                <Section icon={<Send className="w-5 h-5" />} title="Telegram">
                    <div className={`p-3 rounded-lg border mb-4 ${settings.hasTelegramToken ? 'bg-green-50 dark:bg-green-950 border-green-200' : 'bg-gray-50 dark:bg-gray-800 border-gray-200'}`}>
                        <div className="flex items-center gap-2">
                            {settings.hasTelegramToken ? (
                                <Check className="w-4 h-4 text-green-600" />
                            ) : (
                                <AlertCircle className="w-4 h-4 text-yellow-600" />
                            )}
                            <span className="text-sm">
                                {settings.hasTelegramToken ? 'Telegram подключён' : 'Telegram не настроен'}
                            </span>
                        </div>
                    </div>

                    <div className="space-y-3">
                        <div>
                            <Label className="text-xs text-gray-500">Bot Token (от @BotFather)</Label>
                            <Input
                                type="password"
                                value={telegramToken}
                                onChange={e => { setTelegramToken(e.target.value); setTelegramValid(false); }}
                                placeholder={settings.hasTelegramToken ? "••••••••••" : "123456:ABC-DEF..."}
                                className="mt-1"
                            />
                        </div>
                        <div>
                            <Label className="text-xs text-gray-500">Chat ID</Label>
                            <Input
                                type="text"
                                value={telegramChatId}
                                onChange={e => { setTelegramChatId(e.target.value); setTelegramValid(false); }}
                                placeholder="123456789"
                                className="mt-1"
                            />
                        </div>
                        <div className="flex gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleValidateTelegram}
                                disabled={validating || !telegramToken || !telegramChatId}
                                className="flex-1"
                            >
                                {validating && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
                                {telegramValid && <Check className="w-4 h-4 text-green-500 mr-1" />}
                                Проверить
                            </Button>
                        </div>
                    </div>

                    <div className="mt-4 pt-4 border-t">
                        <ToggleRow
                            icon="📱"
                            label="Включить Telegram уведомления"
                            desc="Fallback когда браузер закрыт"
                            checked={settings.telegramEnabled}
                            onChange={v => update('telegramEnabled', v)}
                            disabled={!settings.hasTelegramToken && !telegramValid}
                        />
                    </div>
                </Section>

                {/* Тихие часы */}
                <Section icon={<Moon className="w-5 h-5" />} title="Тихие часы">
                    <ToggleRow
                        icon="🔕"
                        label="Включить тихие часы"
                        desc="Не беспокоить в указанное время"
                        checked={settings.quietHoursEnabled}
                        onChange={v => update('quietHoursEnabled', v)}
                    />

                    {settings.quietHoursEnabled && (
                        <div className="mt-4 space-y-3 pl-4 border-l-2 border-purple-200">
                            <div className="flex items-center gap-2">
                                <span className="text-sm">С</span>
                                <Input
                                    type="number"
                                    min={0}
                                    max={23}
                                    value={settings.quietHoursStart}
                                    onChange={e => update('quietHoursStart', parseInt(e.target.value) || 22)}
                                    className="w-16 text-center"
                                />
                                <span className="text-sm">:00 до</span>
                                <Input
                                    type="number"
                                    min={0}
                                    max={23}
                                    value={settings.quietHoursEnd}
                                    onChange={e => update('quietHoursEnd', parseInt(e.target.value) || 8)}
                                    className="w-16 text-center"
                                />
                                <span className="text-sm">:00</span>
                            </div>
                            <ToggleRow
                                icon="📅"
                                label="Только выходные"
                                checked={settings.quietHoursWeekendOnly}
                                onChange={v => update('quietHoursWeekendOnly', v)}
                            />
                        </div>
                    )}
                </Section>

                {/* Браузер */}
                <Section icon={<Volume2 className="w-5 h-5" />} title="Браузер">
                    <div className="space-y-3">
                        <ToggleRow
                            icon="🔔"
                            label="Push-уведомления"
                            desc="Уведомления на рабочем столе"
                            checked={settings.browserPushEnabled}
                            onChange={v => update('browserPushEnabled', v)}
                        />
                        <ToggleRow
                            icon="🔊"
                            label="Звуковые уведомления"
                            checked={settings.browserSoundEnabled}
                            onChange={v => update('browserSoundEnabled', v)}
                        />

                        {settings.browserSoundEnabled && (
                            <div className="grid grid-cols-2 gap-2 pl-4">
                                {SOUND_OPTIONS.map(option => (
                                    <button
                                        key={option.value}
                                        onClick={() => update('browserSoundType', option.value)}
                                        className={`p-2 text-left rounded-lg border text-sm ${settings.browserSoundType === option.value
                                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
                                            : 'border-gray-200 dark:border-gray-700'
                                            }`}
                                    >
                                        <div className="font-medium">{option.label}</div>
                                        <div className="text-xs text-gray-500">{option.description}</div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </Section>

                {/* Инструкция */}
                <div className="p-3 bg-blue-50 dark:bg-blue-950 rounded-lg text-sm text-blue-700 dark:text-blue-300">
                    <p className="font-medium mb-1">💡 Как получить Chat ID:</p>
                    <ol className="list-decimal list-inside text-xs space-y-1">
                        <li>Создайте бота через @BotFather и получите токен</li>
                        <li>Отправьте боту сообщение /start</li>
                        <li>Откройте api.telegram.org/bot{'<TOKEN>'}/getUpdates</li>
                        <li>Найдите "chat":{"{"}"id": ваш_chat_id{"}"}</li>
                    </ol>
                </div>
                    </div>
                </main>
            </div>
        </div>
    );
}

// Компоненты-хелперы
function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
    return (
        <div className="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-4">
                <span className="text-blue-600">{icon}</span>
                <h2 className="font-semibold">{title}</h2>
            </div>
            {children}
        </div>
    );
}

function ToggleRow({
    icon,
    label,
    desc,
    checked,
    onChange,
    disabled
}: {
    icon: string;
    label: string;
    desc?: string;
    checked: boolean;
    onChange: (v: boolean) => void;
    disabled?: boolean;
}) {
    return (
        <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
                <span>{icon}</span>
                <div>
                    <span className="text-sm">{label}</span>
                    {desc && <p className="text-xs text-gray-500">{desc}</p>}
                </div>
            </div>
            <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
        </div>
    );
}
