import { useState } from "react";
import { Plus, Trash2, X, AlignLeft, CheckSquare, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import TextareaAutosize from 'react-textarea-autosize';
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface NoteBlock {
    id: string;
    type: 'text' | 'check';
    content: string;
    checked?: boolean;
}

export interface NoteEditorProps {
    initialData?: {
        id?: number;
        title?: string;
        type?: 'note' | 'document';
        blocks?: NoteBlock[];
        tags?: string[];
        isPinned?: boolean;
        isArchived?: boolean;
        isImmutable?: boolean;
        // Backward compat
        content?: string;
        items?: Array<{ id?: string; text: string; checked?: boolean }>;
    };
    onSubmit: (data: any) => void;
    onCancel: () => void;
    isLoading?: boolean;
}

let blockIdCounter = 0;
function generateId() {
    return `block-${Date.now()}-${blockIdCounter++}`;
}

function initBlocks(initialData?: NoteEditorProps['initialData']): NoteBlock[] {
    if (initialData?.blocks && initialData.blocks.length > 0) {
        return initialData.blocks;
    }
    // Backward compat: content + items → blocks
    const result: NoteBlock[] = [];
    if (initialData?.content) {
        result.push({ id: generateId(), type: 'text', content: initialData.content });
    }
    if (initialData?.items) {
        for (const item of initialData.items) {
            result.push({ id: generateId(), type: 'check', content: item.text, checked: item.checked });
        }
    }
    if (result.length === 0) {
        // Начинаем с пустого текстового блока
        result.push({ id: generateId(), type: 'text', content: '' });
    }
    return result;
}

export function NoteEditor({ initialData, onSubmit, onCancel, isLoading }: NoteEditorProps) {
    const [title, setTitle] = useState(initialData?.title || "");
    const [type] = useState<'note' | 'document'>(
        (initialData?.type as 'note' | 'document') || "note"
    );
    const [blocks, setBlocks] = useState<NoteBlock[]>(initBlocks(initialData));
    const [tags, setTags] = useState<string[]>(initialData?.tags || []);
    const [newTag, setNewTag] = useState("");
    const [isPinned, setIsPinned] = useState(initialData?.isPinned || false);

    const isImmutable = initialData?.isImmutable || false;

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim()) return;

        onSubmit({
            title: title.trim(),
            type,
            blocks: blocks.filter(b => b.content.trim()),
            tags,
            isPinned,
        });
    };

    // --- Теговый редактор ---
    const handleAddTag = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && newTag.trim()) {
            e.preventDefault();
            const tag = newTag.trim().replace(/^#/, '');
            if (!tags.includes(tag)) {
                setTags([...tags, tag]);
            }
            setNewTag("");
        }
    };

    const removeTag = (tagToRemove: string) => {
        setTags(tags.filter(t => t !== tagToRemove));
    };

    // --- Блочный редактор ---
    const addBlock = (type: 'text' | 'check') => {
        setBlocks(prev => [...prev, { id: generateId(), type, content: '', checked: false }]);
    };

    const updateBlock = (id: string, content: string) => {
        setBlocks(prev => prev.map(b => b.id === id ? { ...b, content } : b));
    };

    const toggleBlock = (id: string) => {
        setBlocks(prev => prev.map(b => b.id === id ? { ...b, checked: !b.checked } : b));
    };

    const removeBlock = (id: string) => {
        setBlocks(prev => prev.filter(b => b.id !== id));
    };

    const handleBlockKeyDown = (e: React.KeyboardEvent, blockId: string, blockType: 'text' | 'check') => {
        // Enter в check-блоке → новый check-блок следом
        if (e.key === 'Enter' && blockType === 'check') {
            e.preventDefault();
            const idx = blocks.findIndex(b => b.id === blockId);
            const newBlock: NoteBlock = { id: generateId(), type: 'check', content: '', checked: false };
            setBlocks(prev => {
                const next = [...prev];
                next.splice(idx + 1, 0, newBlock);
                return next;
            });
            // Фокус перейдёт через useEffect (или автоматически)
        }
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-5">
            {/* Заголовок */}
            <div>
                <Label htmlFor="note-title">Название</Label>
                <Input
                    id="note-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Введите название..."
                    className="text-lg font-medium mt-1"
                    required
                    autoFocus
                    disabled={isImmutable}
                />
            </div>

            {/* Теги */}
            <div>
                <Label>Теги</Label>
                <div className="mt-1 border rounded-md p-2 bg-white dark:bg-gray-950 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                    <div className="flex flex-wrap gap-2 mb-2">
                        {tags.map((tag) => (
                            <Badge key={tag} variant="secondary" className="gap-1 px-2 py-1">
                                #{tag}
                                <X className="h-3 w-3 cursor-pointer hover:text-red-500" onClick={() => removeTag(tag)} />
                            </Badge>
                        ))}
                    </div>
                    <Input
                        value={newTag}
                        onChange={(e) => setNewTag(e.target.value)}
                        onKeyDown={handleAddTag}
                        placeholder="Добавить тег (Enter)..."
                        className="border-0 focus-visible:ring-0 px-0 h-7 shadow-none text-sm"
                    />
                </div>
            </div>

            {/* Блочный редактор */}
            <div>
                <Label>Содержимое</Label>
                <div className="mt-2 space-y-2 border rounded-md p-3 bg-white dark:bg-gray-950 min-h-[140px]">
                    {blocks.map((block) => (
                        <div key={block.id} className="flex items-start gap-2 group">
                            {/* Иконка типа */}
                            <div className="flex-shrink-0 mt-2 text-gray-300 cursor-grab">
                                <GripVertical className="h-4 w-4" />
                            </div>

                            {block.type === 'check' && (
                                <input
                                    type="checkbox"
                                    checked={block.checked}
                                    onChange={() => toggleBlock(block.id)}
                                    className="mt-[10px] h-4 w-4 rounded border-gray-300 cursor-pointer flex-shrink-0"
                                    disabled={isImmutable}
                                />
                            )}

                            {block.type === 'text' ? (
                                <TextareaAutosize
                                    value={block.content}
                                    onChange={(e) => updateBlock(block.id, e.target.value)}
                                    placeholder="Текст..."
                                    className="flex-1 w-full min-h-[60px] bg-transparent border-0 focus-visible:ring-1 focus-visible:ring-offset-0 shadow-none p-1 resize-none"
                                    disabled={isImmutable}
                                    minRows={2}
                                />
                            ) : (
                                <Input
                                    value={block.content}
                                    onChange={(e) => updateBlock(block.id, e.target.value)}
                                    onKeyDown={(e) => handleBlockKeyDown(e, block.id, 'check')}
                                    placeholder="Пункт чеклиста..."
                                    className={cn(
                                        "flex-1 border-0 focus-visible:ring-1 focus-visible:ring-offset-0 shadow-none px-1 h-8",
                                        block.checked && "line-through text-gray-400"
                                    )}
                                    disabled={isImmutable}
                                />
                            )}

                            {!isImmutable && (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 flex-shrink-0"
                                    onClick={() => removeBlock(block.id)}
                                >
                                    <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                            )}
                        </div>
                    ))}

                    {/* Кнопки добавления блоков */}
                    {!isImmutable && (
                        <div className="flex gap-2 pt-2 border-t border-dashed border-gray-100 dark:border-gray-800 mt-2">
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => addBlock('text')}
                                className="text-xs text-gray-500 hover:text-gray-700 h-7 px-2 gap-1.5"
                            >
                                <AlignLeft className="h-3.5 w-3.5" />
                                + Текст
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => addBlock('check')}
                                className="text-xs text-gray-500 hover:text-gray-700 h-7 px-2 gap-1.5"
                            >
                                <CheckSquare className="h-3.5 w-3.5" />
                                + Пункт
                            </Button>
                        </div>
                    )}
                </div>
            </div>

            {/* Закрепить */}
            <div className="flex items-center space-x-2">
                <Switch id="pinned" checked={isPinned} onCheckedChange={setIsPinned} />
                <Label htmlFor="pinned" className="cursor-pointer">Закрепить</Label>
            </div>

            {/* Кнопки */}
            <div className="flex justify-end gap-3 pt-4 border-t border-gray-200 dark:border-gray-800">
                <Button type="button" variant="outline" onClick={onCancel} disabled={isLoading}>
                    Отмена
                </Button>
                <Button type="submit" disabled={isLoading || !title.trim()}>
                    {isLoading ? "Сохранение..." : "Сохранить"}
                </Button>
            </div>
        </form>
    );
}
