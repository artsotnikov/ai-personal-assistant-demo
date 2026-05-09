import { Wifi, WifiOff, RotateCw } from "lucide-react";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";

interface ConnectionStatusIconProps {
    status: 'connecting' | 'connected' | 'disconnected' | 'error';
}

export function ConnectionStatusIcon({ status }: ConnectionStatusIconProps) {
    const getStatusInfo = () => {
        switch (status) {
            case 'connected':
                return {
                    icon: <Wifi className="w-4 h-4" />,
                    tooltip: 'Подключено',
                    className: 'text-green-500'
                };
            case 'connecting':
                return {
                    icon: <RotateCw className="w-4 h-4 animate-spin" />,
                    tooltip: 'Подключение...',
                    className: 'text-yellow-500'
                };
            case 'disconnected':
                return {
                    icon: <WifiOff className="w-4 h-4" />,
                    tooltip: 'Отключено',
                    className: 'text-gray-400'
                };
            case 'error':
                return {
                    icon: <WifiOff className="w-4 h-4" />,
                    tooltip: 'Ошибка подключения',
                    className: 'text-red-500'
                };
        }
    };

    const { icon, tooltip, className } = getStatusInfo();

    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    <div className={`flex items-center justify-center ${className}`}>
                        {icon}
                    </div>
                </TooltipTrigger>
                <TooltipContent>
                    <p>{tooltip}</p>
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}
