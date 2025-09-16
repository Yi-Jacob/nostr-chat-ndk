import React, {useEffect} from 'react';
import {getKeys} from 'local-storage';
import {useAtom} from 'jotai';
import {keysAtom} from 'atoms';
import {useNDK} from './ndk';

const KeysProvider = (props: { children: React.ReactNode }) => {
    const [keys, setKeys] = useAtom(keysAtom);
    const { createSigner } = useNDK();

    useEffect(() => {
        getKeys().then(setKeys);
    }, []);

    // Create NDK signer when keys are available
    useEffect(() => {
        if (keys && createSigner) {
            createSigner(keys.priv);
        }
    }, [keys, createSigner]);

    if (keys === undefined) return null; // Wait until we find keys from storage

    return <>
        {props.children}
    </>;
}

export default KeysProvider;
