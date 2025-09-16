import React from 'react'
import ThemeProvider from 'providers/theme';
import ToastProvider from 'providers/toast';
import ModalProvider from 'providers/modal';
import PopoverProvider from 'providers/popover';
import NDKProvider from 'providers/ndk';
import RavenProvider from 'providers/raven';
import KeysProvider from 'providers/keys';
import RemoteDataProvider from 'providers/remote-data';

const Providers = (props: { children: React.ReactNode }) => {
    return (
        <ThemeProvider>
            <ModalProvider>
                <ToastProvider>
                    <PopoverProvider>
                        <NDKProvider>
                            <KeysProvider>
                                <RemoteDataProvider>
                                    <RavenProvider>
                                        {props.children}
                                    </RavenProvider>
                                </RemoteDataProvider>
                            </KeysProvider>
                        </NDKProvider>
                    </PopoverProvider>
                </ToastProvider>
            </ModalProvider>
        </ThemeProvider>
    );
}

export default Providers;
